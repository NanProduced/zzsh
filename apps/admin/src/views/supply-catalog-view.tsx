import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { adminRequest, AdminApiError, friendlyError, hasPermission, type CatalogSkinOwner, type AdminGunsmithFirearm, type AdminGunsmithResponse, type AdminCatalogResponse, type CatalogEntitlement, type CatalogItem, type CatalogMediaOption, type CatalogRarity, type CatalogSkin, type CatalogSkinCategory, type MediaOptionsResponse, type SessionSnapshot, type SupplyGame } from "../api";
import { Button, StatusMessage } from "../components/ui-elements";
import { skinContractReady, skinValues, skinPayload, ownerPayload, catalogReceipt, ownerKinds, skinStates } from "./catalog-skin-fields";

type CatalogKind = "items" | "categories" | "skins" | "rarities" | "entitlements" | "skin-owners";
type EditorState = { kind: CatalogKind; id?: string; values: Record<string, string>; revision?: string; confirm?: boolean; original?: CatalogSkin | CatalogSkinOwner };
type WriteIntent = { scope: string; sequence: number; kind: CatalogKind; id?: string; path: string; method: "POST" | "PUT"; body: Record<string, unknown>; key: string; expectedCode?: string; uncertain?: boolean };
type WritePhase = "idle" | "saving" | "unknown" | "conflict" | "readback";
const EMPTY_GAMES: SupplyGame[] = [];


const TAB_LABELS: Record<CatalogKind, string> = {
  items: "计费物品",
  categories: "皮肤分类",
  skins: "皮肤",
  "skin-owners": "所属对象",
  rarities: "稀有度",
  entitlements: "账号权益",
};

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

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs";

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
  if (!editing) {
    payload.code = values.code;
  }
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
    // Editing only: mediaId binds an approved public ITEM_MEDIA asset; an empty
    // value unbinds. New items are created without an image.
    if (editing && values.mediaId !== undefined) {
      payload.mediaId = values.mediaId === "" ? null : values.mediaId;
    }
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
  const canReadGunsmith = hasPermission(snapshot, "supply.gunsmith.manage");
  const actorScope = `${snapshot.adminUserId}:${snapshot.session.id}:${snapshot.security.isBoss}:${snapshot.permissions.slice().sort().join(",")}:${canManage}:${canReadGunsmith}`;
  const isBoss = snapshot.security.isBoss;
  const [loadedGames, setGames] = useState<SupplyGame[]>([]);
  const [gameId, setGameId] = useState("");
  const [loadedCatalog, setCatalog] = useState<AdminCatalogResponse | null>(null);
  const [tab, setTab] = useState<CatalogKind>("items");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [conflictLoaded, setConflictLoaded] = useState(false);
  const [writePhase, setWritePhase] = useState<WritePhase>("idle");
  const writeIntent = useRef<WriteIntent | null>(null);
  const writeBusy = useRef(false);
  const writeSeq = useRef(0);
  const gamesSeq = useRef(0), catalogSeq = useRef(0), firearmsSeq = useRef(0);
  const scope = `${actorScope}|${gameId}`;
  const scopeRef = useRef(scope), actorRef = useRef(actorScope);
  scopeRef.current = scope; actorRef.current = actorScope;
  const gamesScope = useRef(""), catalogScope = useRef("");
  const gamesReady = gamesScope.current === actorScope;
  const games = gamesReady ? loadedGames : EMPTY_GAMES;
  const catalog = catalogScope.current === scope ? loadedCatalog : null;
  const contractReady = skinContractReady(catalog);
  const [firearms, setFirearms] = useState<AdminGunsmithFirearm[]>([]);
  const [firearmsError, setFirearmsError] = useState<string>();
  const [firearmsLoading, setFirearmsLoading] = useState(false);

  const [gameDraft, setGameDraft] = useState({ code: "", name: "", description: "" });
  const [mediaOptions, setMediaOptions] = useState<CatalogMediaOption[]>([]);
  const [mediaOptionsLoading, setMediaOptionsLoading] = useState(false);
  const [mediaOptionsError, setMediaOptionsError] = useState<string>();
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaNextCursor, setMediaNextCursor] = useState<string | null>(null);
  // Monotonic sequence guards against late responses: any fetch only commits
  // its result when the sequence still matches. The media picker lifecycle is
  // bound to the editor identity (kind+id) and the selected game, NOT to every
  // draft keystroke, so typing in ordinary fields must not reset the picker.
  const mediaPickSeq = useRef(0);
  const editorIdentity = editor ? `${editor.kind}:${editor.id ?? ""}` : null;
  // Cursor of the most recent request; kept when the request fails so the "重试"
  // button reloads exactly the failed page (null = first page).
  const [mediaRetryCursor, setMediaRetryCursor] = useState<string | null>(null);

  const changeEditor = (next: EditorState | null) => {
    if (next !== null && writePhase !== "idle") return;
    const preservingPending = next === null && ["saving", "unknown", "readback"].includes(writePhase);
    if (!preservingPending) {
      writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false;
      setWritePhase("idle"); setSuccess(undefined); setError(undefined);
    }
    setConflictLoaded(false); setEditor(next);
  };

  useEffect(() => {
    writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false;
    setEditor(null); setWritePhase("idle"); setConflictLoaded(false); setError(undefined); setSuccess(undefined);
    setCatalog(null); setFirearms([]); setFirearmsError(undefined);
    return () => { writeSeq.current += 1; writeIntent.current = null; writeBusy.current = false; catalogSeq.current += 1; mediaPickSeq.current += 1; firearmsSeq.current += 1; };
  }, [scope]);

  const loadGames = useCallback(async () => {
    const token = ++gamesSeq.current, actor = actorRef.current;
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    if (token !== gamesSeq.current || actor !== actorRef.current) return;
    if (!Array.isArray(result?.games)) throw new Error("游戏目录响应不完整。");
    gamesScope.current = actor; setGames(result.games);
    setGameId(current => current && result.games.some(g => g.id === current) ? current : result.games[0]?.id ?? "");
  }, []);

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
    onDirtyChange(Boolean(editor) || writePhase === "unknown" || writePhase === "saving");
    return () => onDirtyChange(false);
  }, [editor, writePhase, onDirtyChange]);

  const loadFirearms = async () => {
    if (!canReadGunsmith || !gameId) return;
    const token = ++firearmsSeq.current, context = scope;
    setFirearmsLoading(true); setFirearmsError(undefined);
    try {
      const result = await adminRequest<AdminGunsmithResponse>(`/supply/games/${gameId}/firearms`);
      if (context !== scopeRef.current || token !== firearmsSeq.current) return;
      if (!Array.isArray(result?.firearms) || result.firearms.some(f => f.gameId !== gameId || typeof f.id !== "string" || typeof f.name !== "string" || typeof f.enabled !== "boolean")) throw new Error("枪械目录响应不完整。");
      setFirearms(result.firearms.filter(f => f.gameId === gameId));
    } catch (failure) { if (context === scopeRef.current && token === firearmsSeq.current) { setFirearms([]); setFirearmsError(failure instanceof AdminApiError && [403,404].includes(failure.status) ? "当前身份或游戏范围无法读取枪械目录。" : friendlyError(failure)); } }
    finally { if (context === scopeRef.current && token === firearmsSeq.current) setFirearmsLoading(false); }
  };

  const readback = async (context: string, sequence: number) => {
    try {
      const data = await loadCatalog(gameId);
      if (scopeRef.current !== context || sequence !== writeSeq.current) return;
      if (!data) throw new Error("目录回读未完成");
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
      if ((intent.kind === "skins" || intent.kind === "skin-owners") && !catalogReceipt(result, intent.kind, intent.body, intent.id, intent.expectedCode)) {
        intent.uncertain = true; setWritePhase("unknown"); setError("尚不能确认提交结果。请核对原提交，不要重新创建或更改提交内容。"); return;
      }
      writeIntent.current = null;
      setSuccess(`${TAB_LABELS[intent.kind]}已保存${intent.kind === "skins" && !intent.id ? "为停用待核草稿；请另行确认身份。" : "；稳定身份保持不变。"}`);
      setEditor(null);
      await readback(intent.scope, intent.sequence);
    } catch (failure) {
      if (!current()) return;
      const unknown = !(failure instanceof AdminApiError) || failure.status === 0 || failure.status >= 500 || (intent.uncertain && [401,403,404,423].includes(failure.status));
      if (unknown) { intent.uncertain = true; setWritePhase("unknown"); setError("未能确认提交结果。请恢复当前身份与权限后核对原提交，不要重复新建。"); }
      else {
        writeIntent.current = null;
        setWritePhase(failure.status === 409 ? "conflict" : "idle"); setConflictLoaded(false);
        setError(failure.status === 409 ? "目录版本已变化或来源存在冲突，输入已保留。请读取最新目录并核对后重新提交。" : friendlyError(failure));
      }
    } finally { if (current()) writeBusy.current = false; }
  };

  const beginWrite = (kind: CatalogKind, body: Record<string, unknown>, id?: string) => {
    if (writeBusy.current || writePhase !== "idle" || !canManage) return;
    const intent: WriteIntent = { scope, sequence: writeSeq.current, kind, id,
      path: id ? `/supply/${kind}/${id}` : `/supply/games/${gameId}/${EDITOR_COLLECTION[kind]}`,
      expectedCode: id && (kind === "skins" || kind === "skin-owners") ? (kind === "skins" ? catalog?.skins : catalog?.owners)?.find(r => r.id === id)?.code : undefined,
      method: id ? "PUT" : "POST", body: JSON.parse(JSON.stringify(body)), key: `idem_${crypto.randomUUID().replaceAll("-", "")}` };
    writeIntent.current = intent; void runWrite(intent);
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
        for (const key of ["name", "categoryId", "rarityCode", "sortOrder", "enabled", "formVisible", "aliases", "ownerKind", "ownerId", "baseName", "sourceNamespace", "sourceField", "sourceToken"]) if (values[key] === previous[key] && fresh[key] !== undefined) values[key] = fresh[key]!;
      }
      setEditor({ ...editor, revision: catalog.game.catalogRevision, original: latest, values });
    }
    setWritePhase("idle"); setConflictLoaded(false); setError(undefined); setSuccess("已采用当前版本并保留修改过的输入，请核对后手动保存。");
  };

  const createGame = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const context = scopeRef.current;
    if (writeBusy.current) return;
    setError(undefined);
    if (!CODE_PATTERN.test(gameDraft.code)) {
      setError("游戏 code 无效：需以小写字母开头，仅含小写字母、数字、下划线、冒号或连字符。");
      return;
    }
    if (!gameDraft.name.trim()) {
      setError("游戏名称不能为空。");
      return;
    }
    setLoading(true);
    try {
      await adminRequest("/supply/games", { code: gameDraft.code, name: gameDraft.name.trim(), ...(gameDraft.description.trim() ? { description: gameDraft.description.trim() } : {}) });
      if (scopeRef.current !== context) return;
      setSuccess("游戏已创建；目录从空开始，旧资料需按来源映射另行核验。");
      setGameDraft({ code: "", name: "", description: "" });
      await loadGames();
    } catch (failure) {
      if (scopeRef.current === context) setError(friendlyError(failure));
    } finally {
      if (scopeRef.current === context) setLoading(false);
    }
  };

  const openCreate = (kind: CatalogKind) => {
    if ((kind === "skins" || kind === "skin-owners") && !contractReady) { setError("当前环境尚未提供完整皮肤身份合同，维护暂不可用。"); return; }
    if (kind === "skins" && !catalog?.categories.length) { setError("请先维护至少一个皮肤分类，再创建皮肤。"); return; }
    changeEditor({ kind, values: editorValuesFor(kind), revision: catalog?.game.catalogRevision });
  };

  const openEdit = (kind: CatalogKind, record: CatalogItem | CatalogSkinCategory | CatalogSkin | CatalogRarity | CatalogEntitlement | CatalogSkinOwner, confirm = false) => {
    if ((kind === "skins" || kind === "skin-owners") && !contractReady) { setError("当前环境尚未提供完整皮肤身份合同，维护暂不可用。"); return; }
    const values = { ...editorValuesFor(kind), ...recordValues(kind, record as unknown as Record<string, unknown>) };
    if (kind === "skins") Object.assign(values, skinValues(record as CatalogSkin));
    if (kind === "skin-owners") Object.assign(values, { ownerKind: (record as CatalogSkinOwner).kind, reason: "" });
    changeEditor({ kind, id: record.id, values, revision: catalog?.game.catalogRevision, confirm,
      ...(kind === "skins" || kind === "skin-owners" ? { original: record as CatalogSkin | CatalogSkinOwner } : {}) });
  };

  const saveEditor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || writeBusy.current || writePhase !== "idle") return;
    try {
      if (editor.kind === "skins" || editor.kind === "skin-owners") {
        if (!contractReady) throw new Error("当前环境的皮肤身份合同未就绪。");
        if (!editor.id && !CODE_PATTERN.test(editor.values.code ?? "")) throw new Error("请填写有效的稳定code。");
        if (editor.kind === "skins" && editor.confirm) {
          const source = editor.values.ownerKind === "FIREARM" ? firearms : catalog!.owners.filter(o => o.kind === editor.values.ownerKind);
          if (editor.values.ownerKind === "FIREARM" && !canReadGunsmith) throw new Error("没有枪械目录读取权限，不能确认枪械所属关系。");
          const chosen = source.find(o => o.id === editor.values.ownerId);
          const old = (editor.original as CatalogSkin)?.ownerRef;
          if (!chosen || (!chosen.enabled && !(old?.id === chosen.id && old.kind === editor.values.ownerKind && (editor.original as CatalogSkin).namingState === "VERIFIED"))) throw new Error("请选择已读取且可挂接的所属对象。");
        }
        const body = editor.kind === "skins" ? skinPayload(editor.values, editor.revision ?? "", editor.original as CatalogSkin | undefined, editor.confirm) : ownerPayload(editor.values, editor.revision ?? "", editor.original as CatalogSkinOwner | undefined);
        beginWrite(editor.kind, body, editor.id);
      } else {
        const validation = validateEditor(editor.kind, editor.values, Boolean(editor.id)); if (validation) throw new Error(validation);
        beginWrite(editor.kind, toPayload(editor.kind, editor.values, Boolean(editor.id)), editor.id);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "请检查填写内容。"); }
  };

  const toggle = (kind: CatalogKind, record: { id: string; enabled?: boolean; formVisible?: boolean }, field: "enabled" | "formVisible") => {
    if (writePhase !== "idle") return;
    if (kind === "skin-owners") {
      const owner = catalog?.owners.find(o => o.id === record.id); if (!owner) return;
      openEdit(kind, owner); setEditor(current => current ? { ...current, values: { ...current.values, enabled: String(!owner.enabled) } } : current); return;
    }
    if (kind === "skins") {
      const skin = catalog?.skins.find(s => s.id === record.id);
      if (!contractReady || !skin) { setError("皮肤身份合同未就绪。"); return; }
      if (!record[field] && skin.namingState !== "VERIFIED") { setError("请先显式确认皮肤身份，再启用或展示。"); return; }
      beginWrite(kind, { [field]: !record[field], expectedCatalogRevision: catalog!.game.catalogRevision }, record.id); return;
    }
    beginWrite(kind, { [field]: !record[field] }, record.id);
  };

  useEffect(() => {
    // Editor identity or game changed (not draft values): dismiss the picker,
    // invalidate any in-flight request and clear every transient state so a
    // late response can never reach the current editor's picker.
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
    if (!editor || editor.kind !== "items" || !editor.id || !gameId) return;
    if (!cursor) {
      // A fresh open clears stale candidates before the request starts.
      setMediaOptions([]);
      setMediaNextCursor(null);
    }
    setMediaOptionsError(undefined);
    setMediaOptionsLoading(true);
    setMediaRetryCursor(cursor);
    const seq = ++mediaPickSeq.current;
    const context = scopeRef.current;
    try {
      const params = new URLSearchParams({ purpose: "ITEM_MEDIA", limit: "20" });
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
        // No stale candidates may remain clickable when the first load fails.
        setMediaOptions([]);
        setMediaNextCursor(null);
      }
      // mediaRetryCursor stays at the failed cursor so the retry reloads it.
    } finally {
      if (seq === mediaPickSeq.current && scopeRef.current === context) setMediaOptionsLoading(false);
    }
  };

  const openMediaPicker = () => {
    if (!editor || editor.kind !== "items" || !editor.id) return;
    setMediaPickerOpen(true);
    void loadMediaOptionsPage(null);
  };

  const pickMedia = (mediaId: string) => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId } });
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  };

  const unbindMedia = () => {
    if (!editor) return;
    mediaPickSeq.current += 1;
    setEditor({ ...editor, values: { ...editor.values, mediaId: "" } });
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
    setSuccess("已解除绑定；保存成功后目录将不再投影该图片。");
  };

  const categories = catalog?.categories ?? [];
  const descendantsOf = useMemo(() => {
    if (!editor || editor.kind !== "categories" || !editor.id) return new Set<string>();
    const result = new Set<string>([editor.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const category of categories) {
        if (category.parentId && result.has(category.parentId) && !result.has(category.id)) {
          result.add(category.id);
          changed = true;
        }
      }
    }
    return result;
  }, [categories, editor]);

  if (!canManage) {
    return <section className="section-panel"><StatusMessage error="当前账号没有供给目录维护权限；Boss 也需按游戏对象范围操作。" /></section>;
  }

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>目录维护</h3>
            <p>计费物品、皮肤分类、皮肤与权益分开维护；稳定 code 创建后不可更改；已引用词条只能停用，不能物理删除。皮肤与稀有度不参与自动定价。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 mt-4">
          <Field label="游戏">
            <select value={gameId} onChange={(event) => { changeEditor(null); setCatalog(null); setGameId(event.target.value); }} className={selectClass}>
              {games.length === 0 ? <option value="">暂无可维护游戏</option> : null}
              {games.map((game) => <option key={game.id} value={game.id}>{game.name}（{game.code}）</option>)}
            </select>
          </Field>
          {catalog ? <span className="text-[11px] text-muted-foreground pb-2">目录版本 {catalog.game.catalogRevision}{catalog.game.enabled ? "" : " · 已停用"}</span> : null}
        </div>
        <StatusMessage error={error} success={success} className="mt-3" />
        {writePhase === "unknown" ? <Button type="button" size="sm" variant="secondary" onClick={() => { if (writeIntent.current) void runWrite(writeIntent.current); }}>核对原提交</Button> : null}
        {writePhase === "readback" ? <Button type="button" size="sm" variant="secondary" onClick={() => void readback(scope, writeSeq.current)}>重新读取目录</Button> : null}
        {writePhase === "conflict" ? <div className="flex gap-2 mt-2"><Button type="button" size="sm" variant="secondary" onClick={() => void reloadConflict()}>读取最新目录</Button><Button type="button" size="sm" variant="secondary" disabled={!conflictLoaded} onClick={adoptRevision}>采用当前版本并保留输入</Button></div> : null}

      </section>

      {isBoss && games.length === 0 ? (
        <section className="section-panel">
          <h3 className="text-sm font-semibold mb-2">创建首个游戏</h3>
          <form onSubmit={createGame} className="grid grid-cols-1 md:grid-cols-3 gap-3" noValidate>
            <Field label="稳定 code"><input value={gameDraft.code} onChange={(event) => setGameDraft({ ...gameDraft, code: event.target.value })} className={inputClass} placeholder="delta" /></Field>
            <Field label="名称"><input value={gameDraft.name} onChange={(event) => setGameDraft({ ...gameDraft, name: event.target.value })} className={inputClass} placeholder="三角洲行动" /></Field>
            <Field label="描述（可选）"><input value={gameDraft.description} onChange={(event) => setGameDraft({ ...gameDraft, description: event.target.value })} className={inputClass} /></Field>
            <Button type="submit" size="sm" loading={loading}>创建游戏</Button>
          </form>
          {!isBoss ? <StatusMessage error="仅 Boss 可以创建游戏对象。" className="mt-3" /> : null}
        </section>
      ) : null}

      {catalog ? (
        <section className="section-panel">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TAB_LABELS) as CatalogKind[]).map((kind) => (
              <Button key={kind} type="button" size="sm" variant={tab === kind ? "primary" : "secondary"} onClick={() => { changeEditor(null); setTab(kind); }}>{TAB_LABELS[kind]}</Button>
            ))}
          </div>

          {(tab === "skins" || tab === "skin-owners") && !contractReady ? <StatusMessage error="当前环境尚未提供完整皮肤身份字段，维护暂不可用；请协调后端环境，不将缺失字段视为空目录。" className="mt-3" /> : null}
          {editor ? (
            <form onSubmit={saveEditor} className="mt-4 border border-border rounded-md p-4 space-y-3">
              <h4 className="text-xs font-semibold">{editor.confirm ? "确认皮肤身份" : editor.id ? `编辑${TAB_LABELS[editor.kind]}` : `新增${TAB_LABELS[editor.kind]}`}</h4>
              {editor.id ? <p className="text-xs text-muted-foreground">ID：{editor.id}{editor.kind === "skins" ? ` · ${skinStates[(editor.original as CatalogSkin).namingState]}` : ""}</p> : null}
              {editor.kind === "skins" || editor.kind === "skin-owners" ? <p className="text-xs text-muted-foreground">本次编辑版本 {editor.revision}。{editor.confirm ? "显示名由服务端生成；确认身份不自动启用。" : !editor.id && editor.kind === "skins" ? "创建为停用的待核草稿；创建后另行确认身份。" : "改名不更换稳定身份。"}</p> : null}
              <fieldset disabled={writePhase === "saving" || writePhase === "unknown" || writePhase === "readback"} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="稳定 code" hint={editor.id ? "已创建不可修改" : "小写字母开头，仅字母数字 _ : -"}>
                  <input value={editor.values.code} disabled={Boolean(editor.id)} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, code: event.target.value } })} className={inputClass} />
                </Field>
                <Field label="名称"><input disabled={editor.confirm || (editor.kind === "skins" && (editor.original as CatalogSkin)?.namingState === "VERIFIED") || (editor.kind === "skin-owners" && Boolean(editor.id))} value={editor.values.name} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, name: event.target.value } })} className={inputClass} /></Field>
                {editor.kind === "items" ? (
                  <Field label="单位">
                    <select value={editor.values.unit} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, unit: event.target.value } })} className={selectClass}>
                      <option value="HAFF_BASE">HAFF_BASE（哈夫币基础单位）</option>
                      <option value="ROUND">ROUND（发）</option>
                      <option value="PIECE">PIECE（件）</option>
                      <option value="DAY">DAY（天）</option>
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "categories" ? (
                  <Field label="父分类">
                    <select value={editor.values.parentId ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, parentId: event.target.value } })} className={selectClass}>
                      <option value="">（一级分类）</option>
                      {categories.filter((category) => !descendantsOf.has(category.id)).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "skins" ? (
                  <>
                    <Field label="分类">
                      <select value={editor.values.categoryId} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, categoryId: event.target.value } })} className={selectClass}>
                        <option value="">请选择</option>
                        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                      </select>
                    </Field>
                    <Field label="稀有度（可空）">
                      <select value={editor.values.rarityCode ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, rarityCode: event.target.value } })} className={selectClass}>
                        <option value="">未标注（不默认金色）</option>
                        {(catalog.rarities ?? []).map((rarity) => <option key={rarity.id} value={rarity.code}>{rarity.name}</option>)}
                      </select>
                    </Field>
                  </>
                ) : null}
                {editor.kind === "entitlements" ? (
                  <>
                    <Field label="值类型">
                      <select value={editor.values.valueKind} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, valueKind: event.target.value } })} className={selectClass}>
                        <option value="FLAG">FLAG</option>
                        <option value="LEVEL">LEVEL</option>
                        <option value="CAPACITY">CAPACITY</option>
                      </select>
                    </Field>
                    <Field label="有效类型">
                      <select value={editor.values.expiryKind} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, expiryKind: event.target.value } })} className={selectClass}>
                        <option value="PERMANENT">PERMANENT</option>
                        <option value="TIMED">TIMED</option>
                      </select>
                    </Field>
                  </>
                ) : null}
                {editor.kind !== "skin-owners" ? <Field label="排序"><input type="number" value={editor.values.sortOrder} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sortOrder: event.target.value } })} className={inputClass} /></Field> : null}
                {"enabled" in editor.values ? (
                  <Field label="启用">
                    <select disabled={(editor.kind === "skins" && (editor.confirm || (editor.original as CatalogSkin)?.namingState !== "VERIFIED")) || (editor.kind === "skin-owners" && !editor.id)} value={editor.values.enabled} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, enabled: event.target.value } })} className={selectClass}>
                      <option value="true">启用</option>
                      <option value="false">停用</option>
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "categories" || editor.kind === "skins" ? (
                  <Field label="表单展示">
                    <select disabled={editor.kind === "skins" && (editor.confirm || (editor.original as CatalogSkin)?.namingState !== "VERIFIED")} value={editor.values.formVisible} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, formVisible: event.target.value } })} className={selectClass}>
                      <option value="true">展示</option>
                      <option value="false">隐藏</option>
                    </select>
                  </Field>
                ) : null}
                {editor.kind === "items" ? (
                  <>
                    <Field label="发布必填"><select value={editor.values.required} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, required: event.target.value } })} className={selectClass}><option value="false">可选</option><option value="true">必填</option></select></Field>
                    <Field label="数量精度"><input type="number" min={0} max={6} value={editor.values.quantityScale} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, quantityScale: event.target.value } })} className={inputClass} /></Field>
                  </>
                ) : null}
                {editor.kind === "items" ? (
                  <>
                    <Field label="旧来源字段（可选）"><input value={editor.values.sourceField ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceField: event.target.value } })} className={inputClass} placeholder="如 knifeSkin" /></Field>
                    <Field label="旧原始值（受限保留）"><input value={editor.values.sourceToken ?? ""} onChange={(event) => setEditor({ ...editor, values: { ...editor.values, sourceToken: event.target.value } })} className={inputClass} /></Field>
                  </>
                ) : null}
              </div>
              {(editor.kind === "skins" && editor.confirm) || (editor.kind === "skin-owners" && !editor.id) ? <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="所属对象类型"><select value={editor.values.ownerKind} onChange={e => { setEditor({ ...editor, values: { ...editor.values, ownerKind: e.target.value, ownerId: "" } }); }} className={selectClass}><option value="AGENT">干员</option><option value="MELEE_TYPE">刀型</option>{editor.kind === "skins" ? <option value="FIREARM">枪械</option> : null}</select></Field>
                {editor.kind === "skins" ? <>
                  <Field label="所属对象" hint="按稳定ID选择；分类不是所属对象。"><select disabled={editor.values.ownerKind === "FIREARM" && !canReadGunsmith} value={editor.values.ownerId} onChange={e => setEditor({ ...editor, values: { ...editor.values, ownerId: e.target.value } })} className={selectClass}>
                    <option value="">请选择已读取对象</option>
                    {(editor.values.ownerKind === "FIREARM" ? firearms : catalog.owners.filter(o => o.kind === editor.values.ownerKind)).map(o => <option key={o.id} value={o.id} disabled={!o.enabled && !((editor.original as CatalogSkin).namingState === "VERIFIED" && (editor.original as CatalogSkin).ownerRef?.id === o.id)}>{o.name} · {o.id}{o.enabled ? "" : "（停用）"}</option>)}
                  </select></Field>
                  <Field label="皮肤本名"><input value={editor.values.baseName} onChange={e => setEditor({ ...editor, values: { ...editor.values, baseName: e.target.value } })} className={inputClass} /></Field>
                  {editor.values.ownerKind === "FIREARM" ? <div className="md:col-span-3">{canReadGunsmith ? <Button type="button" size="sm" variant="secondary" loading={firearmsLoading} onClick={() => void loadFirearms()}>读取枪械目录</Button> : <StatusMessage error="当前身份没有枪械目录读取权限，不能选择或确认枪械；请协调具备权限的维护者，不会临时加权。" />}<StatusMessage error={firearmsError} /></div> : null}
                </> : null}
              </div> : null}
              {editor.kind === "skins" ? <div className="space-y-3">
                <Field label="别名（每行一个）"><textarea value={editor.values.aliases} onChange={e => setEditor({ ...editor, values: { ...editor.values, aliases: e.target.value } })} className={`${inputClass} h-20`} /></Field>
                <p className="text-xs text-muted-foreground">当前主来源：{(editor.original as CatalogSkin)?.sourceNamespace ?? "命名空间未核"} / {(editor.original as CatalogSkin)?.sourceField ?? "无"} / {(editor.original as CatalogSkin)?.sourceToken ?? "无"}</p>
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={Boolean((editor.original as CatalogSkin)?.sourceNamespace)} checked={editor.values.changeSource === "true"} onChange={e => setEditor({ ...editor, values: { ...editor.values, changeSource: String(e.target.checked) } })} />{editor.id ? "主动挂接主来源（普通保存不回传来源）" : "填写已核主来源（可选）"}</label>
                {editor.values.changeSource === "true" ? <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Field label="来源命名空间"><input value={editor.values.sourceNamespace} onChange={e => setEditor({ ...editor, values: { ...editor.values, sourceNamespace: e.target.value } })} className={inputClass} /></Field>
                  <Field label="来源字段"><input readOnly={Boolean((editor.original as CatalogSkin)?.sourceField)} value={editor.values.sourceField} onChange={e => setEditor({ ...editor, values: { ...editor.values, sourceField: e.target.value } })} className={inputClass} /></Field>
                  <Field label="原始来源值" hint="保留原文，不拆分或拼接。"><input readOnly={Boolean((editor.original as CatalogSkin)?.sourceToken)} value={editor.values.sourceToken} onChange={e => setEditor({ ...editor, values: { ...editor.values, sourceToken: e.target.value } })} className={inputClass} /></Field>
                </div> : null}
              </div> : null}
              {(editor.kind === "skins" && editor.id) || editor.kind === "skin-owners" ? <Field label="操作原因"><input value={editor.values.reason ?? ""} onChange={e => setEditor({ ...editor, values: { ...editor.values, reason: e.target.value } })} className={inputClass} /></Field> : null}
              {editor.confirm || (editor.kind === "skins" && editor.id && editor.values.changeSource === "true") || (editor.kind === "skin-owners" && !editor.id) ? <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="证据链接（每行一条，最多8条）"><textarea value={editor.values.evidenceUrls ?? ""} onChange={e => setEditor({ ...editor, values: { ...editor.values, evidenceUrls: e.target.value } })} className={`${inputClass} h-20`} /></Field>
                <Field label="证据核对日期"><input type="date" value={editor.values.observedAt ?? ""} onChange={e => setEditor({ ...editor, values: { ...editor.values, observedAt: e.target.value } })} className={inputClass} /></Field>
                <Field label="适用地区"><input value={editor.values.region ?? ""} onChange={e => setEditor({ ...editor, values: { ...editor.values, region: e.target.value } })} className={inputClass} /></Field>
                <Field label="证据说明" hint="说明所属关系及旧名称映射；核对日期、地区和说明用于本次各条链接。"><textarea value={editor.values.note ?? ""} onChange={e => setEditor({ ...editor, values: { ...editor.values, note: e.target.value } })} className={`${inputClass} h-20`} /></Field>
              </div> : null}
              {editor.kind === "items" && editor.id ? (
                <div className="mt-4 border border-border rounded-md p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold">物品图片</h4>
                    {editor.values.mediaId ? (
                      <Button type="button" size="sm" variant="secondary" onClick={unbindMedia}>解除绑定</Button>
                    ) : null}
                  </div>
                  {editor.values.mediaId ? (
                    <div className="flex items-center gap-3">
                      <span className="relative">
                        {/* Approved-public derivative only; never the private
                            evidence endpoint. A revoked asset renders 404 here. */}
                        <img
                          src={`/api/v1/supply/media/${editor.values.mediaId}/content`}
                          alt="当前绑定物品图"
                          className="w-20 h-20 object-cover rounded border border-border"
                          loading="lazy"
                          onLoad={(event) => {
                            event.currentTarget.style.display = "";
                            event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden");
                          }}
                          onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }}
                        />
                        <span data-fallback className="hidden text-[11px] text-muted-foreground">图片加载失败或已不可公开展示（临时网络问题也可能触发本提示）。保存后如需更换，可重新选择或解除绑定。</span>
                      </span>
                      <span className="text-[11px] text-muted-foreground font-mono truncate">{editor.values.mediaId}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">当前未绑定物品图；公开目录将不投影任何图片。</p>
                  )}
                  {mediaPickerOpen ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">服务端已按游戏与用途过滤：ITEM_MEDIA、已审核且允许公开（候选以公共衍生图预览，无需审核读取权限）。</span>
                        <Button type="button" size="sm" variant="ghost" onClick={dismissMediaPicker}>关闭</Button>
                      </div>
                      <StatusMessage error={mediaOptionsError} className="mt-1" />
                      {mediaOptionsLoading && mediaOptions.length === 0 ? <p className="text-xs text-muted-foreground">加载候选图片…</p> : null}
                      {!mediaOptionsLoading && !mediaOptionsError && mediaOptions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">没有可绑定图片；请先在“平台素材审核”上传并审核公开 ITEM_MEDIA 素材。</p>
                      ) : null}
                      {mediaOptions.length > 0 ? (
                        <>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {mediaOptions.map((option) => (
                              <button type="button" key={option.id} className="rounded border border-border overflow-hidden text-left hover:border-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/70" onClick={() => pickMedia(option.id)}>
                                <span className="relative block">
                                  <img src={`/api/v1/supply/media/${option.id}/content`} alt={`候选 ${option.id}`} className="w-full h-16 object-cover" loading="lazy"
                                    onLoad={(event) => { event.currentTarget.style.display = ""; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.add("hidden"); }}
                                    onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.querySelector("[data-fallback]")?.classList.remove("hidden"); }} />
                                  <span data-fallback className="hidden absolute inset-0 grid place-items-center text-[10px] text-muted-foreground bg-surface">预览不可用</span>
                                </span>
                                <span className="block px-1.5 py-1 text-[10px] text-muted-foreground font-mono truncate">{option.id.slice(0, 18)}… · {option.width}×{option.height} · {option.mime}</span>
                              </button>
                            ))}
                          </div>
                          <div className="flex justify-end">
                            {mediaNextCursor && !mediaOptionsError ? (
                              <Button type="button" size="sm" variant="secondary" loading={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaNextCursor)}>加载更多</Button>
                            ) : null}
                            {mediaOptionsError ? (
                              <Button type="button" size="sm" variant="secondary" loading={mediaOptionsLoading} onClick={() => void loadMediaOptionsPage(mediaRetryCursor)}>重试</Button>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" onClick={openMediaPicker}>选择图片</Button>
                  )}
                </div>
              ) : null}
              </fieldset>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={writePhase !== "idle"} loading={writePhase === "saving"}>{editor.confirm ? "确认身份" : editor.kind === "skins" && !editor.id ? "创建停用草稿" : "保存"}</Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => changeEditor(null)}>{["saving", "unknown", "readback"].includes(writePhase) ? "关闭编辑（稍后核对原结果）" : "取消"}</Button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end mt-4"><Button type="button" size="sm" disabled={writePhase !== "idle" || ((tab === "skins" || tab === "skin-owners") && !contractReady)} onClick={() => openCreate(tab)}>新增{TAB_LABELS[tab]}</Button></div>
          )}

          <div className="mt-4">
            {tab === "items" ? (
              <CatalogTable
                rows={catalog.items}
                disabled={writePhase !== "idle"}
                columns={["code", "name", "unit", "sortOrder", "enabled"]}
                labels={{ code: "稳定 code", name: "名称", unit: "单位", sortOrder: "排序", enabled: "状态" }}
                onEdit={(row) => openEdit("items", row)}
                onToggle={(row, field) => void toggle("items", row, field)}
              />
            ) : null}
            {tab === "categories" ? (
              <CatalogTable
                rows={catalog.categories}
                disabled={writePhase !== "idle"}
                columns={["code", "name", "parentId", "sortOrder", "enabled", "formVisible"]}
                labels={{ code: "稳定 code", name: "名称", parentId: "父分类", sortOrder: "排序", enabled: "状态", formVisible: "表单展示" }}
                onEdit={(row) => openEdit("categories", row)}
                onToggle={(row, field) => void toggle("categories", row, field)}
              />
            ) : null}
            {tab === "skins" ? (
              <CatalogTable
                rows={catalog.skins}
                columns={["id", "code", "name", "namingState", "ownerRef", "aliases", "source", "categoryId", "rarityCode", "enabled", "formVisible"]}
                labels={{ id: "稳定ID", code: "稳定 code", name: "名称", namingState: "身份状态", ownerRef: "所属对象", aliases: "别名", source: "主来源", categoryId: "分类", rarityCode: "稀有度", enabled: "状态", formVisible: "表单展示" }}
                disabled={!contractReady || writePhase !== "idle"}
                onConfirm={(row) => openEdit("skins", row as CatalogSkin, true)}
                onEdit={(row) => openEdit("skins", row)}
                onToggle={(row, field) => void toggle("skins", row, field)}
              />
            ) : null}
            {tab === "skin-owners" ? <CatalogTable rows={catalog.owners ?? []} columns={["id", "kind", "code", "name", "enabled"]} labels={{ id: "稳定ID", kind: "类型", code: "稳定 code", name: "名称", enabled: "状态" }} disabled={!contractReady || writePhase !== "idle"} onEdit={row => openEdit("skin-owners", row)} onToggle={row => toggle("skin-owners", row, "enabled")} /> : null}
            {tab === "rarities" ? (
              <CatalogTable
                rows={catalog.rarities}
                disabled={writePhase !== "idle"}
                columns={["code", "name", "sortOrder", "enabled"]}
                labels={{ code: "稳定 code", name: "名称", sortOrder: "排序", enabled: "状态" }}
                onEdit={(row) => openEdit("rarities", row)}
                onToggle={(row, field) => void toggle("rarities", row, field)}
              />
            ) : null}
            {tab === "entitlements" ? (
              <CatalogTable
                rows={catalog.entitlements}
                disabled={writePhase !== "idle"}
                columns={["code", "name", "valueKind", "expiryKind", "sortOrder", "enabled"]}
                labels={{ code: "稳定 code", name: "名称", valueKind: "值类型", expiryKind: "有效类型", sortOrder: "排序", enabled: "状态" }}
                onEdit={(row) => openEdit("entitlements", row)}
                onToggle={(row, field) => void toggle("entitlements", row, field)}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const EDITOR_COLLECTION: Record<CatalogKind, string> = {
  items: "items",
  categories: "categories",
  skins: "skins",
  "skin-owners": "skin-owners",
  rarities: "rarities",
  entitlements: "entitlements",
};

function CatalogTable({
  rows,
  columns,
  labels,
  onEdit,
  onToggle,
  onConfirm,
  disabled = false,
}: {
  rows: Array<Record<string, unknown> & { id: string; enabled?: boolean; formVisible?: boolean }>;
  columns: string[];
  labels: Record<string, string>;
  disabled?: boolean;
  onConfirm?: (row: Record<string, unknown>) => void;
  onEdit: (row: never) => void;
  onToggle: (row: { id: string; enabled?: boolean; formVisible?: boolean }, field: "enabled" | "formVisible") => void;
}) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground py-6 text-center">暂无词条；未配置不代表有效，未知旧值不会被默认成有效词条。</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr>{columns.map((column) => <th key={column}>{labels[column] ?? column}</th>)}<th>操作</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td key={column}>
                  {column === "enabled" || column === "formVisible"
                    ? <button type="button" disabled={disabled || (Boolean(row.namingState) && !row[column] && row.namingState !== "VERIFIED")} className={row[column] ? "text-emerald-400" : "text-muted-foreground"} onClick={() => onToggle(row, column)}>{row[column] ? "已启用 / 显示" : "已停用 / 隐藏"}</button>
                    : column === "namingState" ? (skinStates[row.namingState as keyof typeof skinStates] ?? "未提供身份状态")
                    : column === "ownerRef" && row.ownerRef ? `${ownerKinds[(row.ownerRef as CatalogSkin["ownerRef"])!.kind]} · ${(row.ownerRef as CatalogSkin["ownerRef"])!.id}`
                    : column === "kind" ? ownerKinds[row.kind as keyof typeof ownerKinds]
                    : column === "aliases" ? (Array.isArray(row.aliases) ? row.aliases.join("；") || "无" : "未提供")
                    : column === "source" ? `${row.sourceNamespace ?? "命名空间未核"} / ${row.sourceField ?? "无"} / ${row.sourceToken ?? "无"}`
                    : row[column] === null || row[column] === undefined || row[column] === ""
                      ? <span className="text-muted-foreground">未标注</span>
                      : <span className="font-mono text-[11px]">{String(row[column])}</span>}
                </td>
              ))}
              <td><Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onEdit(row as never)}>编辑</Button>{onConfirm ? <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => onConfirm(row)}>确认身份</Button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
