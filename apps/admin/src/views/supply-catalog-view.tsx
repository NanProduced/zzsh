import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { SupplySelect } from "@/components/supply/supply-select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ChevronDownIcon, ImageIcon, XIcon } from "lucide-react";
import { SupplyWriteLockError, withSupplyWriteLock } from "@/lib/supply-write-lock";

import { adminRequest, AdminApiError, friendlyError, hasPermission, type AdminCatalogResponse, type CatalogSkin, type CatalogSkinOwner, type CatalogMediaOption, type MediaOptionsResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { StatusMessage } from "../components/ui-elements";
import { skinContractReady, skinValues, skinPayload, ownerPayload, catalogReceipt, ownerKinds, rarityOptions, defaultStates } from "./catalog-skin-fields";
import { SkinMetadataFields } from "./supply-catalog/skin-metadata-fields";
import { unitText } from "./supply-review/model";
import { CatalogObjectTable, CellSelect } from "./supply-catalog/catalog-table";
import { CatalogObjectNav } from "./supply-catalog/object-nav";
import {
  applyIdentityFilter,
  categoryPath,
  catalogFirearmOwners,
  catalogFingerprint,
  catalogOperation,
  catalogResource,
  pendingCatalogKey,
  parsePendingCatalog,
  preferredCatalogGame,
  UNIT_LABEL,
  VALUE_KIND_LABEL,
  EXPIRY_KIND_LABEL,
  IDENTITY_FILTER_ITEMS,
  IDENTITY_LABEL,
  matchesQuery,
  OBJECT_DISABLE_NOTE,
  OBJECT_LABEL,
  OBJECT_ORDER,
  OBJECT_PURPOSE,
  objectRows,
  ownerText,
  skinOwnerKind,
  skinIsSelectable,
  skinRarityBasisText,
  pendingIdentityCount,
  type CatalogKind,
  type CatalogRow,
  type IdentityFilter,
  type PendingCatalogWrite,
  type CatalogWriteKind,
} from "./supply-catalog/model";

type EditorState = { kind: CatalogKind; id?: string; values: Record<string, string>; revision?: string; confirm?: boolean; original?: CatalogSkin | CatalogSkinOwner; baseline?: string };
type WriteIntent = PendingCatalogWrite & { scope: string; sequence: number; uncertain?: boolean; restored?: boolean; continueWith?: Record<string, string> };
type WritePhase = "idle" | "saving" | "unknown" | "conflict" | "readback";
const EMPTY_GAMES: SupplyGame[] = [];

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="space-y-1 text-xs block">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  items,
  onValueChange,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <SupplySelect label={label} value={value} options={items} disabled={disabled} onValueChange={onValueChange} />
    </Field>
  );
}

function editorValuesFor(kind: CatalogKind, record?: Record<string, unknown>): Record<string, string> {
  const base: Record<string, string> = { code: "", name: "" };
  if (kind === "items") return { ...base, unit: "PIECE", quantityScale: "0", required: "false", enabled: "true", sortOrder: "0", sourceField: "", sourceToken: "", sourceNote: "" };
  if (kind === "categories") return { ...base, parentId: "", sortOrder: "0", enabled: "true", formVisible: "true" };
  if (kind === "skins") return { ...base, categoryId: "", rarityCode: "", sortOrder: "0", enabled: "false", formVisible: "false", ...skinValues() };
  if (kind === "skin-owners") return { ...base, enabled: "true", ...skinValues() };
  if (kind === "rarities") return { ...base, sortOrder: "0", enabled: "true" };
  return { ...base, valueKind: "FLAG", expiryKind: "PERMANENT", enabled: "true", sortOrder: "0", sourceField: "", sourceToken: "" };
}

function recordValues(kind: CatalogKind, record: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) values[key] = "";
    else values[key] = typeof value === "boolean" ? String(value) : String(value);
  }
  return values;
}

function toPayload(kind: Exclude<CatalogKind, "skins" | "skin-owners">, values: Record<string, string>, editing: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const put = (field: string, key: string, parse: (value: string) => unknown = (value) => value) => {
    if (values[field] === undefined || values[field] === "") return;
    payload[key] = parse(values[field]!);
  };
  if (!editing) payload.code = values.code;
  payload.name = values.name;
  if (kind === "items") {
    put("unit", "unit");
    put("quantityScale", "quantityScale", Number);
    put("required", "required", (value) => value === "true");
    put("enabled", "enabled", (value) => value === "true");
    put("sortOrder", "sortOrder", Number);
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
    put("sourceNote", "sourceNote");
    if (editing && values.mediaId !== undefined) payload.mediaId = values.mediaId === "" ? null : values.mediaId;
  } else if (kind === "categories") {
    payload.parentId = values.parentId === "" ? null : values.parentId;
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("formVisible", "formVisible", (value) => value === "true");
  } else if (kind === "rarities") {
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
  } else {
    put("valueKind", "valueKind");
    put("expiryKind", "expiryKind");
    put("sortOrder", "sortOrder", Number);
    put("enabled", "enabled", (value) => value === "true");
    put("sourceField", "sourceField");
    put("sourceToken", "sourceToken");
  }
  return payload;
}

function validateEditor(kind: CatalogKind, values: Record<string, string>, editing: boolean): string | undefined {
  if (!editing && !CODE_PATTERN.test(values.code ?? "")) return "稳定 code 需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。";
  if (!values.name || values.name.trim().length === 0) return "名称不能为空。";
  if (kind === "items" && !["HAFF_BASE", "ROUND", "PIECE", "DAY"].includes(values.unit ?? "")) return "单位无效。";
  if (kind === "skins" && !values.categoryId) return "皮肤必须选择所属分类。";
  return undefined;
}

export function SupplyCatalogView({
  snapshot,
  onDirtyChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce?: number;
}) {
  const canManage = Boolean(snapshot.adminUserId) && hasPermission(snapshot, "supply.catalog.manage");
  const actorScope = `${snapshot.adminUserId}:${snapshot.session.id}:${snapshot.security.isBoss}:${snapshot.permissions.slice().sort().join(",")}:${canManage}`;
  const isBoss = snapshot.security.isBoss;
  const [loadedGames, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [loadedCatalog, setCatalog] = useState<AdminCatalogResponse | null>(null);
  const [tab, setTab] = useState<CatalogKind>("items");
  const [query, setQuery] = useState("");
  const [identityFilter, setIdentityFilter] = useState<IdentityFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [mediaFilter, setMediaFilter] = useState<"all" | "with-media" | "without-media">("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [rarityFilter, setRarityFilter] = useState("all");
  const [selectableFilter, setSelectableFilter] = useState("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [closeAsked, setCloseAsked] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [conflictLoaded, setConflictLoaded] = useState(false);
  const [writePhase, setWritePhase] = useState<WritePhase>("idle");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [gameAdminOpen, setGameAdminOpen] = useState(false);
  const writeIntent = useRef<WriteIntent | null>(null);
  const writeBusy = useRef(false);
  const writeSeq = useRef(0);
  const gamesSeq = useRef(0), catalogSeq = useRef(0);
  const scope = `${actorScope}|${gameId}`;
  const scopeRef = useRef(scope), actorRef = useRef(actorScope);
  scopeRef.current = scope; actorRef.current = actorScope;
  const gamesScope = useRef(""), catalogScope = useRef("");
  const gamesReady = gamesScope.current === actorScope;
  const games = gamesReady ? loadedGames : EMPTY_GAMES;
  const catalog = catalogScope.current === scope ? loadedCatalog : null;
  const contractReady = skinContractReady(catalog);
  const firearms = useMemo(() => catalogFirearmOwners(catalog), [catalog]);

  const [gameDraft, setGameDraft] = useState({ code: "", name: "", description: "" });
  const [mediaOptions, setMediaOptions] = useState<CatalogMediaOption[]>([]);
  const [mediaOptionsLoading, setMediaOptionsLoading] = useState(false);
  const [mediaOptionsError, setMediaOptionsError] = useState<string>();
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
  const mediaPickSeq = useRef(0);
  const editorIdentity = editor ? `${editor.kind}:${editor.id ?? ""}` : null;
  const mediaPickerPurpose = editor?.kind === "skins" ? "SKIN_MEDIA" : editor?.kind === "items" ? "ITEM_MEDIA" : null;
  const [mediaRetryCursor, setMediaRetryCursor] = useState<string | null>(null);

  const [pendingSwitch, setPendingSwitch] = useState<null | { type: "tab" | "game"; value: string }>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const catalogRoot = useRef<HTMLDivElement>(null);
  const detailOrigin = useRef<{ scope: string; kind: CatalogKind; id?: string; action: "detail-mobile" | "detail" | "edit" } | null>(null);
  const showDetail = (kind: CatalogKind, id?: string, sourceAction?: "detail-mobile") => {
    const action = sourceAction ?? document.activeElement?.getAttribute("data-catalog-action");
    detailOrigin.current = { scope, kind, id, action: action === "detail-mobile" || action === "edit" ? action : "detail" }; setDetailOpen(true);
  };
  const detailFocusTarget = () => {
    const origin = detailOrigin.current, root = catalogRoot.current;
    if (!root) return;
    if (origin?.scope === scopeRef.current && origin.kind === tab) {
      const list = root.querySelector(`[data-catalog-kind="${origin.kind}"]`);
      const row = Array.from(list?.querySelectorAll<HTMLElement>("[data-catalog-row-id]") ?? []).find(node => node.dataset.catalogRowId === (origin.id ?? ""));
      for (const action of [origin.action, "detail", "edit"]) {
        if (action === "detail-mobile" && window.matchMedia("(min-width: 768px)").matches) continue;
        const entry = row?.querySelector<HTMLElement>(`[data-catalog-action="${action}"]:not([disabled]):not([aria-disabled="true"])`);
        if (entry) return entry;
      }
    }
    return Array.from(root.querySelectorAll<HTMLElement>("[data-catalog-list-title]")).find(node => node.dataset.catalogListTitle === tab);
  };
  const [toggleDraft, setToggleDraft] = useState<{ kind: CatalogKind; row: CatalogRow; field: "enabled" | "formVisible"; revision: string } | null>(null);
  const [wideNavigation, setWideNavigation] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const editorDirty = !["saving", "unknown", "readback"].includes(writePhase) && Boolean(editor) && editor!.baseline !== JSON.stringify(editor!.values);
  const applySwitch = (type: "tab" | "game", value: string) => {
    setPendingSwitch(null);
    setTypeFilter("all"); setRarityFilter("all"); setSelectableFilter("all");
    if (type === "game") { changeEditor(null); setCatalog(null); setGameId(value); setCategoryFilter("all"); setMediaFilter("all"); return; }
    changeEditor(null); setTab(value as CatalogKind); setQuery(""); setIdentityFilter("all"); setCategoryFilter("all"); setMediaFilter("all");
  };
  const requestSwitch = (type: "tab" | "game", value: string) => {
    if (editorDirty) { setPendingSwitch({ type, value }); return; }
    applySwitch(type, value);
  };

  const requestClose = () => {
    if (["saving", "unknown", "readback"].includes(writePhase)) { changeEditor(null); return; }
    if (editor && editor.baseline !== JSON.stringify(editor.values)) { setCloseAsked(true); return; }
    changeEditor(null);
  };

  const storeIntent = (intent: WriteIntent) => {
    const stored = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(intent.adminId)), intent.adminId);
    if (stored && (stored.key !== intent.key || stored.fingerprint !== intent.fingerprint)) throw new Error("另一窗口已保存其它原提交，本次操作不会覆盖它；请刷新后核对。");
    const { schema, adminId, gameId, kind, id, path, method, body, key, fingerprint, expectedCode, accepted, createdGameId } = intent;
    window.localStorage.setItem(pendingCatalogKey(adminId), JSON.stringify({ schema, adminId, gameId, kind, id, path, method, body, key, fingerprint, expectedCode, accepted, createdGameId }));
  };

  const clearIntent = (intent: WriteIntent) => {
    const storageKey = pendingCatalogKey(intent.adminId), stored = parsePendingCatalog(window.localStorage.getItem(storageKey), intent.adminId);
    if (stored && (stored.key !== intent.key || stored.fingerprint !== intent.fingerprint)) throw new Error("原提交记录已变化，不会清除另一窗口的请求；请刷新后核对。");
    window.localStorage.removeItem(storageKey);
  };

  const changeEditor = (next: EditorState | null) => {
    if (next !== null && writePhase !== "idle") return;
    const preservingPending = next === null && ["saving", "unknown", "readback"].includes(writePhase);
    if (!preservingPending) {
      writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false;
      setWritePhase("idle"); setSuccess(undefined); setError(undefined);
    }
    setCloseAsked(false);
    setConflictLoaded(false); if (next === null) setDetailOpen(false); setEditor(next);
  };

  useEffect(() => {
    writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false;
    setEditor(null); setWritePhase("idle"); setConflictLoaded(false); setError(undefined); setSuccess(undefined);
    setStorageBlocked(false);
    if (canManage) {
      try {
        const pending = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(snapshot.adminUserId)), snapshot.adminUserId);
        if (pending) {
          writeIntent.current = { ...pending, scope, sequence: writeSeq.current, uncertain: !pending.accepted, restored: true };
          setWritePhase(pending.accepted ? "readback" : "unknown");
          setError(pending.accepted ? "原提交已成功，目录回读尚未完成；请核对原游戏，不要重复提交。" : "检测到尚未核清的目录提交，原请求已保留；请先核对，不要重复新建。");
        }
      } catch { setStorageBlocked(true); setError("无法读取目录恢复记录，新提交已停用。请恢复浏览器存储或联系维护者核对原回执。"); }
    }
    setCatalog(null);
    setQuery(""); setIdentityFilter("all"); setCategoryFilter("all"); setMediaFilter("all"); setTypeFilter("all"); setRarityFilter("all"); setSelectableFilter("all"); setCloseAsked(false); setToggleDraft(null);
    return () => { writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false; catalogSeq.current += 1; mediaPickSeq.current += 1; };
  }, [scope]);

  const loadGames = useCallback(async () => {
    const token = ++gamesSeq.current, actor = actorRef.current;
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    if (token !== gamesSeq.current || actor !== actorRef.current) return;
    if (!Array.isArray(result?.games)) throw new Error("游戏目录响应不完整。");
    gamesScope.current = actor; setGames(result.games);
    setGameId(current => preferredCatalogGame(result.games, current, isBoss));
    return result.games;
  }, [isBoss]);

  const loadCatalog = useCallback(async (targetGameId: string) => {
    const token = ++catalogSeq.current, context = `${actorRef.current}|${targetGameId}`;
    if (!targetGameId) { setCatalog(null); return null; }
    const result = await adminRequest<AdminCatalogResponse>(`/supply/games/${targetGameId}/catalog`);
    if (token !== catalogSeq.current || context !== scopeRef.current) return null;
    if (result?.game?.id !== targetGameId || ![result.items, result.categories, result.skins, result.rarities, result.entitlements].every(Array.isArray)) throw new Error("目录响应不完整。");
    catalogScope.current = context; setCatalog(result); return result;
  }, []);

  useEffect(() => {
    setGameId(""); setGames([]); gamesScope.current = "";
    if (!canManage) return;
    const actor = actorScope;
    void loadGames().catch(f => { if (actorRef.current === actor) setError(friendlyError(f)); });
    return () => { gamesSeq.current += 1; };
  }, [actorScope, canManage, loadGames]);

  useEffect(() => {
    if (!canManage || refreshNonce === 0) return;
    const actor = actorScope;
    void loadGames().catch(f => { if (actorRef.current === actor) setError(friendlyError(f)); });
  }, [refreshNonce, canManage, actorScope, loadGames]);

  useEffect(() => {
    if (!gameId || !gamesReady) return;
    const context = scope;
    setLoading(true);
    void loadCatalog(gameId).catch(f => { if (scopeRef.current === context) { setCatalog(null); setError(friendlyError(f)); } })
      .finally(() => { if (scopeRef.current === context) setLoading(false); });
  }, [gameId, gamesReady, scope, loadCatalog, refreshNonce]);

  useEffect(() => {
    onDirtyChange(Boolean(editor) || ["unknown", "saving", "readback"].includes(writePhase));
    return () => onDirtyChange(false);
  }, [editor, writePhase, onDirtyChange]);

  useEffect(() => {
    if (!editorDirty && !["unknown", "saving", "readback"].includes(writePhase)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty, writePhase]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWideNavigation(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const readback = async (context: string, sequence: number) => {
    const original = writeIntent.current;
    try {
      if (writeIntent.current?.kind === "games") {
        const intent = writeIntent.current, games = await loadGames();
        if (!intent.createdGameId || !games?.some(game => game.id === intent.createdGameId && game.code === intent.body.code)) throw new Error("新游戏身份尚未完成回读核实");
      }
      else if (!await loadCatalog(gameId)) throw new Error("目录回读未完成");
      if (scopeRef.current !== context || sequence !== writeSeq.current) return;
      if (!original) throw new Error("原提交未提供");
      clearIntent(original);
      writeIntent.current = null;
      setWritePhase("idle"); setError(undefined);
    } catch {
      if (scopeRef.current !== context || sequence !== writeSeq.current) return;
      setWritePhase("readback"); setError("提交已成功，但最新目录读取失败；请重新读取，不要重复提交。");
    }
  };

  const runWrite = async (intent: WriteIntent) => {
    if (writeBusy.current || scopeRef.current !== intent.scope || intent.sequence !== writeSeq.current) return;
    writeBusy.current = true; setWritePhase("saving"); setError(undefined); setSuccess(undefined);
    const current = () => scopeRef.current === intent.scope && writeSeq.current === intent.sequence;
    try {
      const result = await adminRequest<unknown>(intent.path, intent.body, intent.method, { "idempotency-key": intent.key });
      if (!current()) return;
      if (intent.kind === "games") {
        intent.accepted = true;
        const game = result && typeof result === "object" ? (result as { game?: { id?: unknown; code?: unknown } }).game : undefined;
        if (!game || typeof game.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(game.id) || game.code !== intent.body.code) { storeIntent(intent); setGameAdminOpen(false); setWritePhase("readback"); setError("游戏创建已收到受理响应，但目标身份尚未核实；请核对原回执，不能再次创建。"); return; }
        intent.createdGameId = game.id;
      }
      if ((intent.kind === "skins" || intent.kind === "skin-owners") && !catalogReceipt(result, intent.kind, intent.body, intent.id, intent.expectedCode)) {
        intent.uncertain = true; setWritePhase("unknown"); setError("尚不能确认提交结果。请核对原提交，不要重新创建或更改提交内容。"); return;
      }
      intent.accepted = true; storeIntent(intent);
      setSuccess(intent.kind === "games" ? "游戏已创建；创建游戏不等于开放供给业务，请继续配置目录、规则与素材。" : `${OBJECT_LABEL[intent.kind]}已保存${intent.kind === "skins" && !intent.id ? "为停用待核草稿；身份确认与启用是独立动作。" : "；稳定身份保持不变。"}`);
      if (intent.kind === "games") { setGameDraft({ code: "", name: "", description: "" }); setGameAdminOpen(false); }
      if (intent.continueWith && intent.kind !== "games") {
        setEditor({ kind: intent.kind, values: { ...editorValuesFor(intent.kind), ...intent.continueWith }, revision: catalog?.game.catalogRevision });
      } else {
        setEditor(null);
      }
      setDetailOpen(false);
      setCloseAsked(false);
      await readback(intent.scope, intent.sequence);
    } catch (failure) {
      if (!current()) return;
      const unknown = intent.accepted || !(failure instanceof AdminApiError) || failure.status === 0 || failure.status >= 500 || (intent.uncertain && [401,403,404,423].includes(failure.status));
      if (unknown) { intent.uncertain = !intent.accepted; setWritePhase(intent.accepted ? "readback" : "unknown"); setError(intent.accepted ? "提交已成功，但回读或恢复状态保存失败；不会重复提交。" : "未能确认提交结果。请恢复当前身份与权限后核对原提交，不要重复新建。"); }
      else {
        try { clearIntent(intent); } catch { setStorageBlocked(true); }
        writeIntent.current = null;
        setWritePhase(failure.status === 409 ? "conflict" : "idle"); setConflictLoaded(false);
        setError(failure.status === 409 ? "目录版本已变化或来源存在冲突，输入已保留。请读取最新目录并核对后重新提交。" : friendlyError(failure));
      }
    } finally { if (current()) writeBusy.current = false; }
  };

  const carryValuesFor = (kind: CatalogKind, values: Record<string, string>): Record<string, string> | undefined => {
    if (kind === "skins") return { categoryId: values.categoryId ?? "", ownerKind: values.ownerKind ?? "AGENT", ownerId: values.ownerKind === "FIREARM" ? "" : values.ownerId ?? "" };
    if (kind === "categories") return { parentId: values.parentId ?? "" };
    return undefined;
  };

  const beginWrite = async (kind: CatalogWriteKind, body: Record<string, unknown>, id?: string, continueWith?: Record<string, string>) => {
    if (writeBusy.current || writePhase !== "idle" || !canManage || storageBlocked) return;
    writeBusy.current = true; setWritePhase("saving");
    const intent: WriteIntent = { schema: 1, adminId: snapshot.adminUserId, gameId, scope, sequence: writeSeq.current, kind, id,
      path: kind === "games" ? "/supply/games" : id ? `/supply/${kind}/${id}` : `/supply/games/${gameId}/${kind}`,
      expectedCode: id && (kind === "skins" || kind === "skin-owners") ? (kind === "skins" ? catalog?.skins : catalog?.owners)?.find(r => r.id === id)?.code : undefined,
      method: id ? "PUT" : "POST", body: JSON.parse(JSON.stringify(body)), key: `idem_${crypto.randomUUID().replaceAll("-", "")}`, fingerprint: "", accepted: false, continueWith };
    try {
      await withSupplyWriteLock(pendingCatalogKey(intent.adminId), async () => {
        if (scopeRef.current !== intent.scope || writeSeq.current !== intent.sequence) return;
        const stored = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(intent.adminId)), intent.adminId);
        if (stored) {
          writeIntent.current = { ...stored, scope: intent.scope, sequence: intent.sequence, restored: true, uncertain: !stored.accepted };
          setWritePhase(stored.accepted ? "readback" : "unknown"); setError("另一窗口已有待核提交，本次请求尚未发送；请先核对原结果。"); return;
        }
        intent.fingerprint = await catalogFingerprint(intent);
        if (scopeRef.current !== intent.scope || writeSeq.current !== intent.sequence) return;
        storeIntent(intent);
        writeIntent.current = intent; writeBusy.current = false;
        await runWrite(intent);
      });
    } catch (failure) {
      if (scopeRef.current !== intent.scope || writeSeq.current !== intent.sequence) return;
      if (!(failure instanceof SupplyWriteLockError) || failure.code === "LOCK_UNAVAILABLE") setStorageBlocked(true);
      setWritePhase("idle"); setError(failure instanceof Error ? `${failure.message} 本次请求尚未发送。` : "无法保存原请求，新提交已停用，本次请求尚未发送。");
    } finally { if (scopeRef.current === intent.scope && writeSeq.current === intent.sequence) writeBusy.current = false; }
  };

  const recoverOriginal = async () => {
    const intent = writeIntent.current;
    if (!intent || !canManage || storageBlocked || writeBusy.current || (intent.kind !== "games" && intent.gameId !== gameId)) return;
    writeBusy.current = true; setWritePhase("saving");
    const current = () => scopeRef.current === intent.scope && writeSeq.current === intent.sequence;
    try {
      await withSupplyWriteLock(pendingCatalogKey(intent.adminId), async () => {
        if (!current()) return;
        const stored = parsePendingCatalog(window.localStorage.getItem(pendingCatalogKey(intent.adminId)), intent.adminId);
        if (stored && (stored.key !== intent.key || stored.fingerprint !== intent.fingerprint)) {
          writeIntent.current = { ...stored, scope: intent.scope, sequence: intent.sequence, restored: true, uncertain: !stored.accepted };
          setWritePhase(stored.accepted ? "readback" : "unknown"); setError("另一窗口已保存其它原提交，本次核对请求尚未发送；请先核对新的原记录。"); return;
        }
        if (!stored) intent.restored = true;
        if (intent.accepted && !intent.restored && (intent.kind !== "games" || intent.createdGameId)) { await readback(scope, writeSeq.current); return; }
        if (!intent.restored && !intent.accepted) { writeBusy.current = false; await runWrite(intent); return; }
        if (await catalogFingerprint(intent) !== intent.fingerprint) throw new Error("原命令指纹不匹配，请联系维护者核对，不能重新提交。");
        const resourceId = catalogResource(intent);
        const params = new URLSearchParams({ operation: catalogOperation(intent), ...(resourceId ? { resourceId } : {}), fingerprint: intent.fingerprint });
        const receipt = await adminRequest<{ receipt: string; operation?: string; resourceId?: string | null; responseStatus?: number; result?: { id?: string } }>(`/supply/operation-result?${params}`, undefined, "GET", { "idempotency-key": intent.key });
        if (!current()) return;
        if (receipt.receipt !== "RECORDED") { setWritePhase(intent.accepted ? "readback" : "unknown"); setError("原回执尚未找到，不能据此判定未执行。保留原请求，不会静默重新提交。"); return; }
        if (receipt.operation !== catalogOperation(intent) || receipt.resourceId !== (resourceId ?? null) || typeof receipt.responseStatus !== "number" || receipt.responseStatus < 200 || receipt.responseStatus >= 300 || typeof receipt.result?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.result.id) || (intent.id && receipt.result.id !== intent.id)) throw new Error("原回执无法确认，请联系维护者核对。");
        intent.accepted = true; if (intent.kind === "games") intent.createdGameId = receipt.result.id; storeIntent(intent); setSuccess("原提交已由受权回执确认，正在读取目录。");
        await readback(intent.scope, intent.sequence);
      });
    } catch (failure) { if (current()) { if (failure instanceof SupplyWriteLockError && failure.code === "LOCK_UNAVAILABLE") setStorageBlocked(true); setWritePhase(intent.accepted ? "readback" : "unknown"); setError(failure instanceof SupplyWriteLockError ? `${failure.message} 本次核对请求尚未发送，原状态保留。` : failure instanceof AdminApiError ? `${friendlyError(failure)} 原请求仍保留，不会重复提交。` : failure instanceof Error ? failure.message : "原请求仍待核对。"); } }
    finally { if (current()) writeBusy.current = false; }
  };

  const reloadConflict = async () => {
    const context = scope, sequence = writeSeq.current;
    try { const data = await loadCatalog(gameId); if (data && context === scopeRef.current && sequence === writeSeq.current) { setConflictLoaded(true); setSuccess("已读取最新目录。请对照表格核对保留的输入，再采用当前版本。"); } }
    catch (f) { if (context === scopeRef.current && sequence === writeSeq.current) setError(friendlyError(f)); }
  };

  const adoptRevision = () => {
    if (!conflictLoaded || !catalog) return;
    if (editor && (editor.kind === "skins" || editor.kind === "skin-owners")) {
      if (!contractReady) { setError("最新目录的身份合同未就绪，暂不能继续。"); return; }
      const latest = editor.id ? (editor.kind === "skins" ? catalog.skins : catalog.owners).find(r => r.id === editor.id) : undefined;
      if (editor.id && !latest) { setError("当前对象已不在可维护目录中，输入保留，请核对范围。"); return; }
      if (editor.kind === "skins" && latest && (latest as CatalogSkin).namingState !== (editor.original as CatalogSkin).namingState) { setError("词条身份状态已变化，请保留输入并重新打开核对。"); return; }
      let values = editor.values;
      if (latest && editor.original) {
        const previous = { ...recordValues(editor.kind, editor.original as unknown as Record<string, unknown>), ...(editor.kind === "skins" ? skinValues(editor.original as CatalogSkin) : {}) };
        const fresh = { ...recordValues(editor.kind, latest as unknown as Record<string, unknown>), ...(editor.kind === "skins" ? skinValues(latest as CatalogSkin) : {}) };
        values = { ...values };
        for (const key of ["name", "categoryId", "rarityCode", "sortOrder", "enabled", "formVisible", "aliases", "ownerKind", "ownerId", "baseName", "mediaId", "sourceNamespace", "sourceField", "sourceToken"]) if (values[key] === previous[key] && fresh[key] !== undefined) values[key] = fresh[key]!;
        for (const key of ["defaultState", "isCollectible", ...(values.changeRarityEvidence === "true" ? [] : ["rarityBasis", "raritySourceName", "rarityEvidenceUrls"]), ...(values.changeMediaSource === "true" ? [] : ["mediaSourceKind", "mediaSourceName", "mediaSourceUrl"])]) if (values[key] === previous[key] && fresh[key] !== undefined) values[key] = fresh[key]!;
      }
      setEditor({ ...editor, revision: catalog.game.catalogRevision, original: latest, values });
    }
    setWritePhase("idle"); setConflictLoaded(false); setError(undefined); setSuccess("已采用当前版本并保留修改过的输入，请核对后手动保存。");
  };

  const createGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isBoss || editor || writeBusy.current || writePhase !== "idle" || storageBlocked) return;
    setError(undefined);
    if (!CODE_PATTERN.test(gameDraft.code)) { setError("游戏 code 无效：需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。"); return; }
    if (!gameDraft.name.trim()) { setError("游戏名称不能为空。"); return; }
    await beginWrite("games", { code: gameDraft.code, name: gameDraft.name.trim(), ...(gameDraft.description.trim() ? { description: gameDraft.description.trim() } : {}) });
  };

  const openCreate = (kind: CatalogKind) => {
    if (storageBlocked || editor) return;
    if ((kind === "skins" || kind === "skin-owners") && !contractReady) { setError("当前环境尚未提供完整皮肤身份合同，维护暂不可用。"); return; }
    if (kind === "skins" && !catalog?.categories.length) { setError("请先维护至少一个皮肤分类，再创建皮肤。"); return; }
    const created = editorValuesFor(kind);
    changeEditor({ kind, values: created, revision: catalog?.game.catalogRevision, baseline: JSON.stringify(created) });
  };

  const openEdit = (kind: CatalogKind, record: CatalogRow, confirm = false) => {
    if (storageBlocked) return;
    if ((kind === "skins" || kind === "skin-owners") && !contractReady) { setError("当前环境尚未提供完整皮肤身份合同，维护暂不可用。"); return; }
    const values = { ...editorValuesFor(kind), ...recordValues(kind, record) };
    if (kind === "skins") Object.assign(values, skinValues(record as unknown as CatalogSkin));
    if (kind === "skin-owners") Object.assign(values, { ownerKind: (record as CatalogSkinOwner).kind, reason: "" });
    changeEditor({ kind, id: record.id, values, revision: catalog?.game.catalogRevision, baseline: JSON.stringify(values), confirm,
      ...(kind === "skins" || kind === "skin-owners" ? { original: record as unknown as CatalogSkin | CatalogSkinOwner } : {}) });
  };

  const saveEditor = (event?: FormEvent<HTMLFormElement>, continueAdd = false) => {
    event?.preventDefault();
    if (!editor || writeBusy.current || writePhase !== "idle" || storageBlocked) return;
    try {
      if (editor.kind === "skins" || editor.kind === "skin-owners") {
        if (!contractReady) throw new Error("当前环境的皮肤身份合同未就绪。");
        if (!editor.id && !CODE_PATTERN.test(editor.values.code ?? "")) throw new Error("请填写有效的稳定code。");
        if (editor.kind === "skins" && editor.confirm) {
          const source = editor.values.ownerKind === "FIREARM" ? firearms : catalog!.owners.filter(o => o.kind === editor.values.ownerKind);
          if (!source) throw new Error("当前目录的枪械归属未接入，不能确认枪械所属关系。");
          const chosen = source.find(o => o.id === editor.values.ownerId);
          const old = (editor.original as CatalogSkin)?.ownerRef;
          const broadMelee = editor.values.ownerKind === "MELEE_TYPE" && !editor.values.ownerId;
          if ((!chosen && !broadMelee) || (chosen && !chosen.enabled && !(old?.id === chosen.id && old.kind === editor.values.ownerKind && (editor.original as CatalogSkin).namingState === "VERIFIED"))) throw new Error("请选择已读取且可挂接的所属对象。");
        }
        const body = editor.kind === "skins" ? skinPayload(editor.values, editor.revision ?? "", editor.original as CatalogSkin | undefined, editor.confirm) : ownerPayload(editor.values, editor.revision ?? "", editor.original as CatalogSkinOwner | undefined);
        beginWrite(editor.kind, body, editor.id, continueAdd ? carryValuesFor(editor.kind, editor.values) : undefined);
      } else {
        const validation = validateEditor(editor.kind, editor.values, Boolean(editor.id)); if (validation) throw new Error(validation);
        beginWrite(editor.kind, toPayload(editor.kind, editor.values, Boolean(editor.id)), editor.id, continueAdd ? carryValuesFor(editor.kind, editor.values) : undefined);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "请检查填写内容。"); }
  };

  const toggleReason = (row: CatalogRow, field: "enabled" | "formVisible"): string | undefined => {
    if (row.namingState && row.namingState !== "VERIFIED" && !row[field]) return "需先核实身份";
    return undefined;
  };

  const toggle = (kind: CatalogKind, record: { id: string; enabled?: boolean; formVisible?: boolean }, field: "enabled" | "formVisible") => {
    if (writePhase !== "idle") return;
    if (kind === "skin-owners") {
      const owner = catalog?.owners.find(o => o.id === record.id); if (!owner) return;
      openEdit(kind, owner as unknown as CatalogRow); setEditor(current => current ? { ...current, values: { ...current.values, enabled: String(!owner.enabled) } } : current); return;
    }
    if (kind === "skins") {
      const skin = catalog?.skins.find(s => s.id === record.id);
      if (!contractReady || !skin) { setError("皮肤身份合同未就绪。"); return; }
      if (!record[field] && skin.namingState !== "VERIFIED") { setError("请先显式确认皮肤身份，再启用或展示。"); return; }
      beginWrite(kind, { [field]: !record[field], expectedCatalogRevision: catalog!.game.catalogRevision }, record.id); return;
    }
    beginWrite(kind, { [field]: !record[field] }, record.id);
  };

  const requestToggle = (kind: CatalogKind, row: CatalogRow, field: "enabled" | "formVisible") => {
    if (writePhase !== "idle" || storageBlocked || editor || !catalog) return;
    if (kind === "skin-owners") { toggle(kind, row, field); return; }
    setToggleDraft({ kind, row, field, revision: catalog.game.catalogRevision });
  };

  const confirmToggle = () => {
    if (!toggleDraft || !catalog) return;
    const current = objectRows(catalog, toggleDraft.kind).find(row => row.id === toggleDraft.row.id);
    if (!current || toggleDraft.revision !== catalog.game.catalogRevision || current[toggleDraft.field] !== toggleDraft.row[toggleDraft.field]) { setToggleDraft(null); setError("对象或目录版本已变化，请重新读取并核对后操作。"); return; }
    toggle(toggleDraft.kind, current, toggleDraft.field); setToggleDraft(null);
  };

  useEffect(() => {
    mediaPickSeq.current += 1;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  }, [editorIdentity, gameId, actorScope]);

  const dismissMediaPicker = () => {
    mediaPickSeq.current += 1;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  };

  const loadMediaOptionsPage = async (cursor: string | null) => {
    if (!editor || !editor.id || !gameId || !mediaPickerPurpose) return;
    if (!cursor) {
      setMediaOptions([]);
      setMediaNextCursor(null);
    }
    setMediaOptionsError(undefined);
    setMediaOptionsLoading(true);
    setMediaRetryCursor(cursor);
    const seq = ++mediaPickSeq.current;
    const context = scopeRef.current;
    try {
      const params = new URLSearchParams({ purpose: mediaPickerPurpose, limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<MediaOptionsResponse>(`/supply/games/${gameId}/media-options?${params.toString()}`);
      if (seq !== mediaPickSeq.current || scopeRef.current !== context) return;
      setMediaOptions((current) => (cursor ? [...current, ...result.items] : result.items));
      setMediaNextCursor(result.nextCursor);
      setMediaRetryCursor(null);
    } catch (failure) {
      if (seq !== mediaPickSeq.current || scopeRef.current !== context) return;
      setMediaOptionsError(friendlyError(failure));
      if (!cursor) {
        setMediaOptions([]);
        setMediaNextCursor(null);
      }
    } finally {
      if (seq === mediaPickSeq.current && scopeRef.current === context) setMediaOptionsLoading(false);
    }
  };

  const openMediaPicker = () => {
    if (!editor || !editor.id || !mediaPickerPurpose) return;
    setMediaPickerOpen(true);
    void loadMediaOptionsPage(null);
  };

  const pickMedia = (mediaId: string) => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId } });
    dismissMediaPicker();
  };

  const unbindMedia = () => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId: "" } });
    dismissMediaPicker();
    setSuccess("已解除绑定；保存成功后目录将不再投影该图片。");
  };

  const counts = useMemo(() => {
    const result = {} as Record<CatalogKind, number>;
    for (const kind of OBJECT_ORDER) result[kind] = objectRows(catalog, kind).length;
    return result;
  }, [catalog]);
  const pending = useMemo(() => pendingIdentityCount(catalog), [catalog]);

  const visibleRows = useMemo(() => {
    const rows = objectRows(catalog, tab);
    let filtered = rows;
    if (tab === "skins") {
      filtered = applyIdentityFilter(filtered, identityFilter);
      if (typeFilter !== "all") filtered = filtered.filter(row => (skinOwnerKind(row as CatalogSkin) ?? "unknown") === typeFilter);
      if (rarityFilter !== "all") filtered = filtered.filter(row => (row.rarityCode ?? "unknown") === rarityFilter);
      if (selectableFilter !== "all") filtered = filtered.filter(row => Boolean(catalog && skinIsSelectable(row as CatalogSkin, catalog)) === (selectableFilter === "selectable"));
      if (categoryFilter !== "all") {
        filtered = filtered.filter((row) => (row as CatalogSkin).categoryId === categoryFilter);
      }
      if (mediaFilter === "with-media") {
        filtered = filtered.filter((row) => Boolean(row.mediaId));
      } else if (mediaFilter === "without-media") {
        filtered = filtered.filter((row) => !row.mediaId);
      }
    }
    return filtered.filter((row) => matchesQuery(row, query));
  }, [catalog, tab, identityFilter, categoryFilter, mediaFilter, typeFilter, rarityFilter, selectableFilter, query]);

  const descendantsOf = useMemo(() => {
    if (!editor || editor.kind !== "categories" || !editor.id) return new Set<string>();
    const result = new Set<string>([editor.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const category of catalog?.categories ?? []) {
        if (category.parentId && result.has(category.parentId) && !result.has(category.id)) {
          result.add(category.id);
          changed = true;
        }
      }
    }
    return result;
  }, [catalog, editor]);

  if (!canManage) {
    return <section className="section-panel"><StatusMessage themeAware tone="warning" error="当前账号没有供给目录维护权限；Boss 也需按游戏对象范围操作。" /></section>;
  }

  const gameItems = games.map((game) => ({ value: game.id, label: `${game.name}（${game.code}）` }));

  const renderCell = (rowKind: CatalogKind, row: CatalogRow, key: string): React.ReactNode => {
    if (key === "media") {
      const mediaId = typeof row.mediaId === "string" && row.mediaId ? row.mediaId : "";
      if (!mediaId) {
        return (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-md border border-dashed border-border/80 bg-muted/20 text-muted-foreground/60 hover:border-primary/50 hover:bg-muted/50 hover:text-foreground"
            disabled={writePhase !== "idle" || Boolean(editor)}
            title="未绑定图片，点击配置"
            aria-label={`绑定图片 ${String(row.name ?? row.code ?? row.id)}`}
            onClick={() => { openEdit(rowKind, row); showDetail(rowKind, row.id); }}
          >
            <ImageIcon className="size-4" />
          </Button>
        );
      }
      return (
        <Button
          type="button"
          variant="outline"
          className="group relative h-9 w-9 overflow-hidden rounded-md p-0 border-border hover:ring-2 hover:ring-primary/40"
          disabled={writePhase !== "idle" || Boolean(editor)}
          aria-label={`查看或更换已绑定图片 ${String(row.code ?? row.id)}`}
          onClick={() => { openEdit(rowKind, row); showDetail(rowKind, row.id); }}
        >
          <img
            src={`/api/v1/supply/media/${mediaId}/content`}
            alt=""
            className="h-full w-full object-contain rounded transition-transform group-hover:scale-105"
            loading="lazy"
            onLoad={event => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
            onError={(event) => {
              event.currentTarget.style.display = "none";
              event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden");
            }}
          />
          <span data-fallback className="hidden absolute inset-0 grid place-items-center bg-muted text-[10px] text-muted-foreground">图失效</span>
        </Button>
      );
    }
    if (key === "parentPath") return <span className="text-xs">{categoryPath(row.parentId as string | null, catalog?.categories ?? [])}</span>;
    if (key === "categoryPath") return <span className="text-xs">{categoryPath(row.categoryId as string | null, catalog?.categories ?? [])}</span>;
    if (key === "ownerRef") {
      const kind = skinOwnerKind(row as CatalogSkin);
      return <div className="space-y-1 text-xs"><p>{kind ? ownerKinds[kind] : "类型待核"}</p><p className="text-muted-foreground">{kind === "MELEE_TYPE" && !row.ownerRef ? "具体刀型待核" : ownerText((row.ownerRef as CatalogSkin["ownerRef"]) ?? null, catalog?.owners ?? [], firearms)}</p></div>;
    }
    if (key === "kind") return <span className="text-xs">{ownerKinds[row.kind as keyof typeof ownerKinds] ?? "未提供"}</span>;
    if (key === "rarityCode") {
      const rarity = (catalog?.rarities ?? []).find(entry => entry.code === row.rarityCode);
      return <div className="space-y-1 text-xs"><p>{rarity ? (rarity.enabled ? rarity.name : `${rarity.name}（已停用）`) : row.rarityCode ? String(row.rarityCode) : "品质未知"}</p><p className="text-muted-foreground">{skinRarityBasisText(row as CatalogSkin)}</p></div>;
    }
    if (key === "appearance") return <div className="space-y-1 text-xs"><p>{defaultStates[(row.defaultState as keyof typeof defaultStates) ?? "UNKNOWN"]}</p><p className="text-muted-foreground">{row.isCollectible == null ? "典藏待确认" : row.isCollectible ? "典藏" : "非典藏"}</p></div>;
    if (key === "required") return <span className="text-xs">{row.required ? "必填" : "可选"}</span>;
    if (key === "unit") return <span className="text-xs">{row.unit === "PIECE" ? unitText("PIECE", String(row.code)) : UNIT_LABEL[String(row.unit)] ?? "单位未登记"}</span>;
    if (key === "valueKind") return <span className="text-xs">{VALUE_KIND_LABEL[String(row.valueKind)] ?? "类型未登记"}</span>;
    if (key === "expiryKind") return <span className="text-xs">{EXPIRY_KIND_LABEL[String(row.expiryKind)] ?? "类型未登记"}</span>;
    if (key === "quantityScale") return <span className="text-xs">{Number.isInteger(row.quantityScale) ? row.quantityScale === 0 ? "整数（例 1）" : `最多${row.quantityScale}位小数` : "未提供"}</span>;
    const value = row[key];
    if (value === null || value === undefined || value === "") return <span className="text-xs text-muted-foreground">未提供</span>;
    return <span className="text-xs">{String(value)}</span>;
  };

  const createReason = !canManage
    ? "当前身份没有目录维护权限。"
    : storageBlocked ? "目录恢复记录未就绪，暂不能提交新修改。"
    : (tab === "skins" || tab === "skin-owners") && !contractReady
      ? "当前环境尚未提供完整皮肤身份合同，维护暂不可用；请协调后端环境，不将缺失字段视为空目录。"
      : tab === "skins" && !(catalog?.categories.length)
        ? "请先维护至少一个皮肤分类，再创建皮肤。"
        : undefined;

  const editorKindLabel = editor ? OBJECT_LABEL[editor.kind] : "";
  const toggleLabel = toggleDraft ? toggleDraft.field === "enabled" ? toggleDraft.row.enabled ? "停用" : "启用" : toggleDraft.row.formVisible ? "隐藏" : "展示" : "修改";


  const editOptions = {
    categoryItems: [{ value: "", label: "（一级分类）" }, ...(catalog?.categories ?? []).filter((category) => !descendantsOf.has(category.id)).map((category) => ({ value: category.id, label: categoryPath(category.id, catalog?.categories ?? []) }))],
    rarityItems: rarityOptions(catalog?.rarities ?? [], editor?.kind === "skins" ? (editor.original as CatalogSkin | undefined)?.rarityCode ?? null : null),
    kindItems: editor?.kind === "skins"
      ? [{ value: "AGENT", label: "干员" }, { value: "MELEE_TYPE", label: "近战外观" }, { value: "FIREARM", label: "枪械" }]
      : [{ value: "AGENT", label: "干员" }, { value: "MELEE_TYPE", label: "刀型" }],
    unitItems: [
      { value: "HAFF_BASE", label: "哈夫币基础单位" },
      { value: "ROUND", label: "发" },
      { value: "PIECE", label: "件/个（整数物品）" },
      { value: "DAY", label: "天" },
    ],
    boolItems: [{ value: "true", label: "是" }, { value: "false", label: "否" }],
    valueKindItems: Object.entries(VALUE_KIND_LABEL).map(([value, label]) => ({ value, label })),
    expiryKindItems: Object.entries(EXPIRY_KIND_LABEL).map(([value, label]) => ({ value, label })),
    nameDisabled: Boolean(editor?.confirm)
      || (editor?.kind === "skins" && (editor.original as CatalogSkin | undefined)?.namingState === "VERIFIED")
      || (editor?.kind === "skin-owners" && Boolean(editor.id)),
  };

  return (
    <div ref={catalogRoot} className="space-y-4">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>目录维护</h3>
            <p>维护发布与计价使用的物品、皮肤和账号属性。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 mt-4">
          <div className="w-full max-w-sm">
            <LabeledSelect label="游戏" value={gameId} disabled={!gamesReady} items={gameItems.length ? gameItems : [{ value: "", label: gamesReady ? "暂无可维护游戏" : "正在读取游戏…" }]} onValueChange={(value) => requestSwitch("game", value)} />
          </div>
          {catalog ? (
            <span className="text-[11px] text-muted-foreground pb-2">
              目录版本 {catalog.game.catalogRevision}
              {catalog.game.enabled ? "" : " · 游戏已停用"}
              {catalog.game.currentReleaseId ? "" : " · 尚无生效发布"}
            </span>
          ) : null}
          {isBoss ? (
            <Dialog open={gameAdminOpen} onOpenChange={setGameAdminOpen}>
              <DialogTrigger render={<Button type="button" variant="outline" size="sm" className="ml-auto h-9" disabled={Boolean(editor) || writePhase !== "idle" || storageBlocked} />}>管理游戏</DialogTrigger>
              <DialogContent className="sm:max-w-md" closeLabel="关闭游戏管理">
                <DialogHeader>
                  <DialogTitle>管理游戏</DialogTitle>
                  <DialogDescription>创建游戏只建立目录容器；不等于开放供给业务，创建后仍需配置目录、规则与素材。</DialogDescription>
                </DialogHeader>
                <GameCreateForm draft={gameDraft} setDraft={setGameDraft} onSubmit={createGame} loading={loading || writePhase !== "idle" || storageBlocked} />
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
        <StatusMessage themeAware error={error} success={success} className="mt-3" />
        {loading && !catalog ? <p role="status" className="mt-3 text-sm text-muted-foreground">正在读取当前游戏目录…</p> : null}
        {writeIntent.current && writeIntent.current.kind !== "games" && writeIntent.current.gameId !== gameId && ["saving", "unknown", "readback"].includes(writePhase) ? <div className="mt-2 flex flex-wrap items-center gap-2"><p className="text-xs text-muted-foreground">另一游戏有待核提交：{games.find(game => game.id === writeIntent.current!.gameId)?.name ?? "原游戏不在当前可读范围"} · {OBJECT_LABEL[writeIntent.current.kind]}。本页新写已锁定。</p><Button type="button" size="sm" variant="outline" disabled={!games.some(game => game.id === writeIntent.current?.gameId)} onClick={() => requestSwitch("game", writeIntent.current!.gameId)}>返回原游戏核对</Button></div> : null}
        {writePhase === "unknown" ? <div className="mt-2 space-y-1"><Button type="button" size="sm" variant="outline" disabled={storageBlocked || (writeIntent.current?.kind !== "games" && writeIntent.current?.gameId !== gameId)} onClick={() => void recoverOriginal()}>核对原提交</Button><p className="text-[11px] text-muted-foreground">结果尚未确认；关闭或刷新不会消除该状态，列表未找到也不能证明未执行。</p></div> : null}
        {writePhase === "readback" ? <Button type="button" size="sm" variant="outline" className="mt-2" disabled={storageBlocked || (writeIntent.current?.kind !== "games" && writeIntent.current?.gameId !== gameId)} onClick={() => void recoverOriginal()}>重新读取目录</Button> : null}
        {writePhase === "conflict" ? <div className="flex flex-wrap gap-2 mt-2"><Button type="button" size="sm" variant="outline" onClick={() => void reloadConflict()}>读取最新目录</Button><Button type="button" size="sm" variant="outline" disabled={!conflictLoaded} onClick={adoptRevision}>采用当前版本并保留输入</Button></div> : null}
      </section>

      {isBoss && gamesReady && !error && games.length === 0 ? (
        <section className="section-panel">
          <h3 className="text-sm font-semibold">创建首个游戏</h3>
          <p className="text-xs text-muted-foreground mt-1">目录按游戏隔离；没有任何游戏时先创建游戏对象，再维护六类词条。</p>
          <GameCreateForm draft={gameDraft} setDraft={setGameDraft} onSubmit={createGame} loading={loading || writePhase !== "idle" || storageBlocked} className="mt-3" />
        </section>
      ) : null}

      {catalog ? (
        <Tabs value={tab} orientation="horizontal" onValueChange={(value) => requestSwitch("tab", String(value))} className="w-full space-y-4">
          <CatalogObjectNav kind={tab} counts={counts} pending={pending} loaded={Boolean(catalog)} />
          <div className="space-y-4 min-w-0">
            {OBJECT_ORDER.map((kind) => (
              <TabsContent key={kind} value={kind} className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
                  <div>
                    <h4 data-catalog-list-title={kind} tabIndex={-1} className="rounded-sm text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{OBJECT_LABEL[kind]}</h4>
                    <p className="text-xs text-muted-foreground">{OBJECT_PURPOSE[kind]}</p>
                  </div>
                  <Collapsible>
                    <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground" />}>
                      维护说明<ChevronDownIcon className="size-3.5" />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="max-w-2xl py-1 text-xs text-muted-foreground">稳定编号创建后不变。{OBJECT_DISABLE_NOTE[kind]}</p>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
                {(kind === "skins" || kind === "skin-owners") && !contractReady && visibleRows.length > 0 ? (
                  <p className="text-xs text-destructive">当前环境尚未提供完整皮肤身份合同，维护暂不可用；请协调后端环境，不将缺失字段视为空目录。</p>
                ) : null}
                <div className="flex flex-wrap items-end gap-2.5">
                  <div className="w-full sm:w-auto sm:min-w-60">
                    <Field label="在已加载目录中查找">
                      <Input value={query} disabled={Boolean(editor)} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full text-xs" placeholder="名称、code 或别名" />
                    </Field>
                  </div>
                  {kind === "skins" ? (
                    <>
                      <div className="w-36"><LabeledSelect label="类型筛选" value={typeFilter} disabled={Boolean(editor)} items={[{ value: "all", label: "全部类型" }, ...Object.entries(ownerKinds).map(([value, label]) => ({ value, label })), { value: "unknown", label: "类型待核" }]} onValueChange={setTypeFilter} /></div>
                      <div className="w-36"><LabeledSelect label="品质筛选" value={rarityFilter} disabled={Boolean(editor)} items={[{ value: "all", label: "全部品质" }, { value: "unknown", label: "品质未知" }, ...catalog.rarities.map(r => ({ value: r.code, label: r.name }))]} onValueChange={setRarityFilter} /></div>
                      <div className="w-36"><LabeledSelect label="可选状态" value={selectableFilter} disabled={Boolean(editor)} items={[{ value: "all", label: "全部状态" }, { value: "selectable", label: "可选择" }, { value: "unselectable", label: "暂不可选择" }]} onValueChange={setSelectableFilter} /></div>
                      <div className="w-36">
                        <LabeledSelect label="身份状态" value={identityFilter} disabled={Boolean(editor)} items={IDENTITY_FILTER_ITEMS.map((entry) => ({ value: entry.value, label: entry.label }))} onValueChange={(value) => setIdentityFilter(value as IdentityFilter)} />
                      </div>
                      <div className="w-44">
                        <LabeledSelect
                          label="分类筛选"
                          value={categoryFilter}
                          disabled={Boolean(editor)}
                          items={[
                            { value: "all", label: "全部分类" },
                            ...(catalog?.categories ?? []).map((c) => ({ value: c.id, label: categoryPath(c.id, catalog?.categories ?? []) })),
                          ]}
                          onValueChange={(value) => setCategoryFilter(value)}
                        />
                      </div>
                      <div className="w-32">
                        <LabeledSelect
                          label="图片状态"
                          value={mediaFilter}
                          disabled={Boolean(editor)}
                          items={[
                            { value: "all", label: "全部图片" },
                            { value: "with-media", label: "已绑定图片" },
                            { value: "without-media", label: "未绑定图片" },
                          ]}
                          onValueChange={(value) => setMediaFilter(value as "all" | "with-media" | "without-media")}
                        />
                      </div>
                    </>
                  ) : null}
                  <div className="ml-auto">
                    <Button type="button" size="sm" className="h-9" disabled={Boolean(editor) || writePhase !== "idle" || Boolean(createReason)} title={createReason} onClick={() => openCreate(kind)}>
                      新增{OBJECT_LABEL[kind]}
                    </Button>
                  </div>
                </div>
                {query.trim() ? <p className="text-[11px] text-muted-foreground">搜索仅覆盖当前已加载目录；空结果不代表全库不存在。</p> : null}
                <CatalogObjectTable
                  editingId={editor && editor.id && editor.kind === kind ? editor.id : undefined}
                  editingIsNew={Boolean(editor && !editor.id && editor.kind === kind)}
                  editValues={editor && editor.kind === kind ? editor.values : undefined}
                  onEditValue={(key, value) => setEditor(current => (current ? { ...current, values: { ...current.values, [key]: value } } : current))}
                  onSaveRow={() => saveEditor()}
                  onCancelRow={requestClose}
                  onDetailRow={() => { if (editor) showDetail(editor.kind, editor.id); }}
                  pendingWrite={writePhase !== "idle"}
                  showReason={editor?.kind === "skins" || editor?.kind === "skin-owners"}
                  onDetail={(row, sourceAction) => { openEdit(kind, row); showDetail(kind, row.id, sourceAction); }}
                  editOptions={editOptions}
                  kind={kind}
                  rows={visibleRows}
                  query={query}
                  filterActive={kind === "skins" && (identityFilter !== "all" || categoryFilter !== "all" || mediaFilter !== "all" || typeFilter !== "all" || rarityFilter !== "all" || selectableFilter !== "all")}
                  busy={writePhase !== "idle" || storageBlocked}
                  contractReady={kind === "skins" || kind === "skin-owners" ? contractReady : true}
                  onEdit={(row) => openEdit(kind, row)}
                  onConfirm={kind === "skins" ? (row) => { openEdit(kind, row, true); showDetail(kind, row.id); } : undefined}
                  onToggle={(row, field) => requestToggle(kind, row, field)}
                  toggleReason={kind === "skins" ? toggleReason : undefined}
                  onCreate={() => openCreate(kind)}
                  createReason={createReason}
                  prerequisiteAction={kind === "skins" && contractReady && !catalog.categories.length ? { label: "去维护皮肤分类", onClick: () => requestSwitch("tab", "categories") } : undefined}
                  onClearQuery={() => { setQuery(""); setIdentityFilter("all"); setCategoryFilter("all"); setMediaFilter("all"); setTypeFilter("all"); setRarityFilter("all"); setSelectableFilter("all"); }}
                  renderCell={(row, key) => renderCell(kind, row, key)}
                />
                <p className="text-xs text-muted-foreground">当前已加载 {counts[kind]} 条{query.trim() || (kind === "skins" && (identityFilter !== "all" || categoryFilter !== "all" || mediaFilter !== "all" || typeFilter !== "all" || rarityFilter !== "all" || selectableFilter !== "all")) ? `，匹配 ${visibleRows.length} 条` : ""}。计数仅覆盖本次目录读取。</p>
              </TabsContent>
            ))}
          </div>
        </Tabs>
      ) : null}

    <Sheet open={detailOpen && Boolean(editor)} onOpenChange={(open) => { if (!open) requestClose(); }}>
      <SheetContent className="w-full! sm:max-w-[560px]! gap-0" showCloseButton={false} finalFocus={detailFocusTarget}>
        <SheetHeader className="shrink-0 border-b border-border pr-14">
          <SheetTitle>{editor?.confirm ? `确认${editorKindLabel}身份` : editor?.kind === "items" ? "计费物品图片" : editor?.kind === "skins" ? "皮肤别名、品质与图片" : editor?.kind === "skin-owners" ? "所属对象身份与证据" : `${editorKindLabel}维护说明`}</SheetTitle>
          <SheetDescription>{editor?.kind === "skins" ? "核实身份、启用和表单展示分别处理；本次修改与行内输入一并保存。" : editor?.kind === "items" ? "选择已审核且可公开的物品图片；保存后才更新绑定。" : editor?.kind === "skin-owners" ? "按证据核实稳定归属，既有身份不能通过改名替换。" : "名称、状态和排序在表格内维护；稳定编号保持不变。"}</SheetDescription>
          <Button type="button" variant="ghost" size="icon" aria-label="关闭详细信息" className="absolute right-3 top-3" onClick={requestClose}><XIcon /></Button>
          {editor?.values.name ? <p className="pt-2 text-sm font-medium break-words">{editor.values.name}</p> : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <StatusMessage themeAware error={error} success={success} />
        {editor ? (
          <fieldset disabled={["saving", "unknown", "readback"].includes(writePhase)} className="min-w-0 space-y-4">
            {editor.confirm || (editor.kind === "skin-owners" && !editor.id) ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="所属对象类型">
                  <CellSelect label="所属对象类型" value={editor.values.ownerKind ?? "AGENT"} items={editOptions.kindItems} onValueChange={(value) => setEditor({ ...editor, values: { ...editor.values, ownerKind: value, ownerId: "" } })} />
                </Field>
                {editor.kind === "skins" ? (
                  <>
                    <Field label="所属对象" hint={editor.values.ownerKind === "MELEE_TYPE" ? "已确认近战大类时可保留具体刀型未知，不新建虚构刀型。" : "按稳定ID选择；分类不是所属对象。"}>
                      <CellSelect
                        label="所属对象"
                        disabled={editor.values.ownerKind === "FIREARM" && firearms === null}
                        value={editor.values.ownerId ?? ""}
                        items={[{ value: "", label: editor.values.ownerKind === "MELEE_TYPE" ? "具体刀型待核（仅确认近战）" : "请选择已读取对象" }, ...(editor.values.ownerKind === "FIREARM" ? firearms ?? [] : (catalog?.owners ?? []).filter(o => o.kind === editor.values.ownerKind)).map(o => ({ value: o.id, label: `${o.name}${o.enabled ? "" : "（停用）"}` }))]}
                        onValueChange={(value) => setEditor({ ...editor, values: { ...editor.values, ownerId: value } })}
                      />
                    </Field>
                    <Field label="皮肤本名"><Input value={editor.values.baseName ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, baseName: event.target.value } })} className="h-9 text-xs" /></Field>
                    {editor.values.ownerKind === "FIREARM" ? (
                      <div className="sm:col-span-2">
                        {firearms === null ? <StatusMessage themeAware error="当前目录的枪械归属未接入，请协调接口环境；不需要临时增加改枪码管理权限。" /> : firearms.length === 0 ? <p className="text-xs text-muted-foreground">当前游戏尚无枪械所属对象，请先维护枪械目录。</p> : <p className="text-xs text-muted-foreground">枪械归属来自当前受权目录，保存稳定对象编号。</p>}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
            {editor.kind === "skins" ? (
              <Field label="别名（每行一个）">
                <Textarea value={editor.values.aliases ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, aliases: event.target.value } })} className="min-h-20 text-xs" />
              </Field>
            ) : null}
            {editor.kind === "skins" && !editor.confirm ? <SkinMetadataFields skin={editor.original as CatalogSkin | undefined} values={editor.values} rarities={editOptions.rarityItems} onChange={(key, value) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current)} /> : null}
            {editor.kind === "skins" ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">当前主来源：{(editor.original as CatalogSkin)?.sourceNamespace ?? "命名空间未核"} / {(editor.original as CatalogSkin)?.sourceField ?? "无"} / {(editor.original as CatalogSkin)?.sourceToken ?? "无"}</p>
                <div className="flex items-center gap-2 text-xs">
                  <Checkbox id="catalog-source-attach" aria-label="主动填写已核主来源" disabled={writePhase !== "idle" || Boolean((editor.original as CatalogSkin)?.sourceNamespace)} checked={editor.values.changeSource === "true"} onCheckedChange={(checked) => setEditor({ ...editor, values: { ...editor.values, changeSource: String(checked) } })} />
                  <label htmlFor="catalog-source-attach">{editor.id ? "主动挂接主来源（普通保存不回传来源）" : "填写已核主来源（可选）"}</label>
                </div>
                {editor.values.changeSource === "true" ? (
                  <div className="grid grid-cols-1 gap-3">
                    <Field label="来源命名空间"><Input value={editor.values.sourceNamespace ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceNamespace: event.target.value } })} className="h-9 text-xs" /></Field>
                    <Field label="来源字段"><Input readOnly={Boolean((editor.original as CatalogSkin)?.sourceField)} value={editor.values.sourceField ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceField: event.target.value } })} className="h-9 text-xs" /></Field>
                    <Field label="原始来源值" hint="保留原文，不拆分或拼接。"><Input readOnly={Boolean((editor.original as CatalogSkin)?.sourceToken)} value={editor.values.sourceToken ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceToken: event.target.value } })} className="h-9 text-xs" /></Field>
                  </div>
                ) : null}
              </div>
            ) : null}
            {editor.kind === "skins" || editor.kind === "skin-owners" ? (
              <Field label="操作原因"><Input value={editor.values.reason ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, reason: event.target.value } })} className="h-9 text-xs" /></Field>
            ) : null}
            {editor.confirm || (editor.kind === "skins" && editor.id && editor.values.changeSource === "true") || (editor.kind === "skin-owners" && !editor.id) ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><Field label="证据链接（每行一条，最多8条）"><Textarea value={editor.values.evidenceUrls ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, evidenceUrls: event.target.value } })} className="min-h-20 text-xs" /></Field></div>
                <div className="sm:col-span-2"><Field label="证据核对日期" hint="已自动填充今日日期"><Input type="date" value={editor.values.observedAt ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, observedAt: event.target.value } })} className="h-9 text-xs" /></Field></div>
                <label className="hidden" aria-hidden="true">
                  <span>适用地区</span>
                  <Input aria-label="适用地区" value={editor.values.region ?? "中国大陆"} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, region: event.target.value } })} className="h-9 text-xs" />
                </label>
                <div className="sm:col-span-2"><Field label="证据说明" hint="说明所属关系及旧名称映射；核对日期用于本次各条链接。"><Textarea value={editor.values.note ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, note: event.target.value } })} className="min-h-20 text-xs" /></Field></div>
              </div>
            ) : null}
            {(editor.kind === "items" || editor.kind === "skins") && editor.id ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold">{editor.kind === "skins" ? "皮肤图片" : "物品图片"}</h4>
                  {editor.values.mediaId ? <Button type="button" size="sm" variant="outline" onClick={unbindMedia}>解除绑定</Button> : null}
                </div>
                <p className="text-[11px] text-muted-foreground">目录页只绑定本平台已审核且允许公开的衍生图，不上传字节；上传在平台素材审核。</p>
                {editor.values.mediaId ? (
                  <div className="flex items-center gap-3">
                    <span className="relative">
                      <img src={`/api/v1/supply/media/${editor.values.mediaId}/content`} alt="当前绑定图片" className={editor.kind === "skins" && editor.values.ownerKind === "AGENT" ? "h-56 w-36 rounded border border-border object-contain" : "h-28 w-48 rounded border border-border object-contain"} loading="lazy"
                        onLoad={(event) => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
                        onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }} />
                      <span data-fallback className="hidden text-[11px] text-muted-foreground">图片加载失败或已不可公开展示。</span>
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground truncate">{editor.values.mediaId}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">当前未绑定图片；公开目录将不投影任何图片。</p>
                )}
                {mediaPickerOpen ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-muted-foreground">候选已按游戏与用途过滤：{mediaPickerPurpose}、已审核且允许公开。</span>
                      <Button type="button" size="sm" variant="ghost" onClick={dismissMediaPicker}>关闭</Button>
                    </div>
                    <StatusMessage themeAware error={mediaOptionsError} />
                    {mediaOptionsLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}
                    {!mediaOptionsLoading && !mediaOptionsError && mediaOptions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">没有可绑定图片；请先在平台素材审核上传并审核公开 {mediaPickerPurpose} 素材。</p>
                    ) : null}
                    {mediaOptions.length > 0 ? (
                      <>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {mediaOptions.map((option) => (
                            <Button type="button" variant="outline" key={option.id} className="h-auto flex-col gap-0 overflow-hidden rounded-md p-0 text-left" onClick={() => pickMedia(option.id)}>
                              <span className="relative block">
                                <img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="h-24 w-full object-contain" loading="lazy"
                                  onLoad={(event) => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
                                  onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }} />
                                <span data-fallback className="absolute inset-0 hidden grid place-items-center bg-surface text-[10px] text-muted-foreground">预览不可用</span>
                              </span>
                              <span className="block truncate px-1.5 py-1 font-mono text-[10px] text-muted-foreground">{option.id.slice(0, 18)}… · {option.width}×{option.height}</span>
                            </Button>
                          ))}
                        </div>
                        <div className="flex justify-end gap-2">
                          {mediaNextCursor && !mediaOptionsError ? <Button type="button" size="sm" variant="outline" disabled={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaNextCursor)}>加载更多</Button> : null}
                          {mediaOptionsError ? <Button type="button" size="sm" variant="outline" disabled={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaRetryCursor)}>重试</Button> : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <Button type="button" size="sm" variant="outline" onClick={openMediaPicker}>绑定图片</Button>
                )}
              </div>
            ) : null}
          </fieldset>
        ) : null}
        </div>
        <SheetFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t border-border">
          <Button type="button" size="sm" variant="ghost" onClick={() => setDetailOpen(false)}>返回行内编辑</Button>
          <Button type="button" size="sm" disabled={writePhase !== "idle" || storageBlocked} onClick={() => saveEditor()}>{writePhase === "saving" ? "保存中…" : "保存"}</Button>
          <Button type="button" size="sm" variant="outline" onClick={requestClose}>{["saving", "unknown", "readback"].includes(writePhase) ? "关闭编辑（稍后核对原结果）" : "取消"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
    <Dialog open={Boolean(toggleDraft)} onOpenChange={(open) => { if (!open) setToggleDraft(null); }}>
      <DialogContent className="sm:max-w-md" closeLabel="关闭状态确认">
        <DialogHeader>
          <DialogTitle>{toggleDraft ? `${toggleLabel}${OBJECT_LABEL[toggleDraft.kind]}？` : "确认状态修改"}</DialogTitle>
          <DialogDescription>{toggleDraft?.row.name ? `「${String(toggleDraft.row.name)}」的稳定身份与历史引用会保留。` : "历史引用会保留。"}引用影响范围尚未提供。{toggleDraft?.kind === "skins" ? "皮肤身份核实、启用与表单展示分别处理。" : ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter><Button type="button" variant="outline" className="h-9" onClick={() => setToggleDraft(null)}>取消</Button><Button type="button" className="h-9" variant={toggleDraft?.row[toggleDraft.field] ? "destructive" : "default"} disabled={writePhase !== "idle" || storageBlocked} onClick={confirmToggle}>确认{toggleLabel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={closeAsked} onOpenChange={setCloseAsked}>
      <DialogContent className="sm:max-w-md" closeLabel="继续编辑" finalFocus={() => editor ? true : detailFocusTarget()}>
        <DialogHeader><DialogTitle>放弃未保存修改？</DialogTitle><DialogDescription>行内输入和详细信息属于同一次修改。取消编辑会一并丢弃；返回编辑可继续保存。</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setCloseAsked(false)}>继续编辑</Button><Button type="button" variant="destructive" onClick={() => changeEditor(null)}>放弃修改</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(pendingSwitch)} onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}>
      <DialogContent className="sm:max-w-md" closeLabel="保留编辑">
        <DialogHeader>
          <DialogTitle>切换将放弃未保存修改</DialogTitle>
          <DialogDescription>当前编辑内容尚未保存；切换对象或游戏会丢弃这些输入。已提交但结果未知的操作不受影响，仍可在页首核对原提交。</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPendingSwitch(null)}>保留编辑</Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => pendingSwitch && applySwitch(pendingSwitch.type, pendingSwitch.value)}>放弃修改并切换</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  );
}

function GameCreateForm({ draft, setDraft, onSubmit, loading, className }: { draft: { code: string; name: string; description: string }; setDraft: (draft: { code: string; name: string; description: string }) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; className?: string }) {
  return (
    <form onSubmit={onSubmit} className={"grid grid-cols-1 gap-3 md:grid-cols-3 " + (className ?? "")} noValidate>
      <Field label="稳定 code"><Input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} className="h-9 text-xs" placeholder="delta" /></Field>
      <Field label="名称"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="h-9 text-xs" placeholder="三角洲行动" /></Field>
      <Field label="描述（可选）"><Input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="h-9 text-xs" /></Field>
      <div className="flex flex-wrap items-center gap-2 md:col-span-3">
        <Button type="submit" size="sm" disabled={loading}>{loading ? "创建中…" : "创建游戏"}</Button>
        <span className="text-[11px] text-muted-foreground">创建后下一步：维护六类词条，再到规则与价目、平台素材审核。</span>
      </div>
    </form>
  );
}
