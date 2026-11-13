import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";

import { adminRequest, friendlyError, hasPermission, type AdminCatalogResponse, type CatalogMediaOption, type CatalogSkin, type SessionSnapshot, type SupplyGame } from "../api";
import { StatusMessage } from "../components/ui-elements";
import { rarityOptions, skinContractReady } from "./catalog-skin-fields";
import { createCatalogCommands } from "./supply-catalog/catalog-commands";
import { CatalogConfirmDialogs } from "./supply-catalog/confirm-dialogs";
import { GameCreateForm, LabeledSelect, type EditorState, type WriteIntent, type WritePhase } from "./supply-catalog/editor-fields";
import { CatalogEditorSurface } from "./supply-catalog/editor-surface";
import { CatalogKindPane } from "./supply-catalog/kind-pane";
import { CatalogObjectNav } from "./supply-catalog/object-nav";
import {
  applyIdentityFilter,
  categoryPath,
  catalogFirearmOwners,
  catalogKindsForGame,
  EXPIRY_KIND_LABEL,
  matchesQuery,
  OBJECT_LABEL,
  OBJECT_ORDER,
  objectRows,
  pendingCatalogKey,
  pendingIdentityCount,
  parsePendingCatalog,
  preferredCatalogGame,
  skinIsSelectable,
  skinOwnerKind,
  VALUE_KIND_LABEL,
  type CatalogKind,
  type CatalogRow,
  type IdentityFilter,
} from "./supply-catalog/model";

const EMPTY_GAMES: SupplyGame[] = [];

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
  useEffect(() => { if (loadedCatalog?.game.code === "delta" && tab === "categories") setTab("skins"); }, [loadedCatalog?.game.code, tab]);
  const [identityFilter, setIdentityFilter] = useState<IdentityFilter>("all");
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
  const [detailSurfaceKind, setDetailSurfaceKind] = useState<CatalogKind | null>(null);
  const catalogRoot = useRef<HTMLDivElement>(null);
  const detailOrigin = useRef<{ scope: string; kind: CatalogKind; id?: string; action: "detail-mobile" | "detail" | "edit" } | null>(null);
  const showDetail = (kind: CatalogKind, id?: string, sourceAction?: "detail-mobile") => {
    const action = sourceAction ?? document.activeElement?.getAttribute("data-catalog-action");
    detailOrigin.current = { scope, kind, id, action: action === "detail-mobile" || action === "edit" ? action : "detail" }; setDetailSurfaceKind(kind); setDetailOpen(true);
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
    setQuery(""); setIdentityFilter("all"); setMediaFilter("all"); setTypeFilter("all"); setRarityFilter("all"); setSelectableFilter("all"); setCloseAsked(false); setToggleDraft(null);
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

  const {
    changeEditor, recoverOriginal, reloadConflict, adoptRevision, createGame, openCreate, openEdit, saveEditor,
    toggleReason, requestToggle, confirmToggle, dismissMediaPicker, loadMediaOptionsPage, openMediaPicker, pickMedia, unbindMedia,
  } = createCatalogCommands({
    writeIntent, writeBusy, writeSeq, scopeRef, scope, mediaPickSeq,
    snapshot, gameId, writePhase, canManage, storageBlocked, editor, catalog,
    contractReady, firearms, isBoss, gameDraft, mediaPickerPurpose, toggleDraft, conflictLoaded,
    loadGames, loadCatalog,
    setWritePhase, setError, setSuccess, setEditor, setCloseAsked, setConflictLoaded, setDetailOpen,
    setStorageBlocked, setGameDraft, setGameAdminOpen, setToggleDraft, setMediaPickerOpen, setMediaOptions,
    setMediaNextCursor, setMediaOptionsLoading, setMediaOptionsError, setMediaRetryCursor,
  });

  const applySwitch = (type: "tab" | "game", value: string) => {
    setPendingSwitch(null);
    setTypeFilter("all"); setRarityFilter("all"); setSelectableFilter("all");
    if (type === "game") { changeEditor(null); setCatalog(null); setGameId(value); setMediaFilter("all"); return; }
    changeEditor(null); setTab(value as CatalogKind); setQuery(""); setIdentityFilter("all"); setMediaFilter("all");
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

  useEffect(() => {
    mediaPickSeq.current += 1;
    setMediaPickerOpen(false);
    setMediaOptions([]);
    setMediaNextCursor(null);
    setMediaOptionsLoading(false);
    setMediaOptionsError(undefined);
    setMediaRetryCursor(null);
  }, [editorIdentity, gameId, actorScope]);

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
      if (mediaFilter === "with-media") {
        filtered = filtered.filter((row) => Boolean(row.mediaId));
      } else if (mediaFilter === "without-media") {
        filtered = filtered.filter((row) => !row.mediaId);
      }
    }
    return filtered.filter((row) => matchesQuery(row, query));
  }, [catalog, tab, identityFilter, mediaFilter, typeFilter, rarityFilter, selectableFilter, query]);

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
    return <section className="section-panel"><StatusMessage themeAware tone="warning" error="当前账号没有游戏目录维护权限；Boss 也需按游戏对象范围操作。" /></section>;
  }

  const gameItems = games.map((game) => ({ value: game.id, label: `${game.name}（${game.code}）` }));

  const createReason = !canManage
    ? "当前身份没有游戏目录维护权限。"
    : storageBlocked ? "目录恢复记录未就绪，暂不能提交新修改。"
    : (tab === "skins" || tab === "skin-owners") && !contractReady
      ? "皮肤目录资料暂时无法确认，维护暂不可用；请稍后重试或联系管理员。"
      : tab === "skins" && catalog?.game.code === "delta" && !catalog.skinCategoryModel?.categorylessWriteReady
        ? "无分类词条创建尚未就绪，请先由维护者更新目录结构。"
      : tab === "skins" && catalog?.game.code !== "delta" && !(catalog?.categories.length)
        ? "请先维护至少一个皮肤分类，再创建皮肤。"
        : undefined;

  const visibleCatalogKinds = catalogKindsForGame(catalog?.game.code);

  const toggleLabel = toggleDraft ? toggleDraft.field === "enabled" ? toggleDraft.row.enabled ? "停用" : "启用" : toggleDraft.row.formVisible ? "隐藏" : "展示" : "修改";


  const editOptions = {
    categoryItems: [{ value: "", label: "（一级分类）" }, ...(catalog?.categories ?? []).filter((category) => !descendantsOf.has(category.id)).map((category) => ({ value: category.id, label: categoryPath(category.id, catalog?.categories ?? []) }))],
    rarityItems: rarityOptions(catalog?.rarities ?? [], editor?.kind === "skins" ? (editor.original as CatalogSkin | undefined)?.rarityCode ?? null : null),
    kindItems: editor?.kind === "skins"
      ? [{ value: "AGENT", label: "干员" }, { value: "MELEE_TYPE", label: "近战外观" }, { value: "FIREARM", label: "枪械" }]
      : [{ value: "AGENT", label: "干员" }, ...(catalog?.game.code === "delta" ? [] : [{ value: "MELEE_TYPE", label: "近战所属对象" }])],
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
            <h3>游戏目录</h3>
            <p>维护发布与计价使用的物品、皮肤和账号属性。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 mt-4">
          <div className="w-full max-w-sm">
            <LabeledSelect label="游戏" value={gameId} disabled={!gamesReady} items={gameItems.length ? gameItems : [{ value: "", label: gamesReady ? "暂无可维护游戏" : "正在读取游戏…" }]} onValueChange={(value) => requestSwitch("game", value)} />
          </div>
          {catalog ? (
            <span className="text-xs text-muted-foreground pb-2">
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
        {writePhase === "unknown" ? <div className="mt-2 space-y-1"><Button type="button" size="sm" variant="outline" disabled={storageBlocked || (writeIntent.current?.kind !== "games" && writeIntent.current?.gameId !== gameId)} onClick={() => void recoverOriginal()}>核对原提交</Button><p className="text-xs text-muted-foreground">结果尚未确认；关闭或刷新不会消除该状态，列表未找到也不能证明未执行。</p></div> : null}
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
          <CatalogObjectNav kind={tab} counts={counts} pending={pending} loaded={Boolean(catalog)} kinds={visibleCatalogKinds} />
          <div className="space-y-4 min-w-0">
            {visibleCatalogKinds.map((kind) => (
              <CatalogKindPane
                key={kind}
                kind={kind}
                contractReady={contractReady}
                visibleRows={visibleRows}
                query={query}
                editor={editor}
                setQuery={setQuery}
                typeFilter={typeFilter}
                setTypeFilter={setTypeFilter}
                rarityFilter={rarityFilter}
                setRarityFilter={setRarityFilter}
                selectableFilter={selectableFilter}
                setSelectableFilter={setSelectableFilter}
                identityFilter={identityFilter}
                setIdentityFilter={setIdentityFilter}
                mediaFilter={mediaFilter}
                setMediaFilter={setMediaFilter}
                catalog={catalog}
                firearms={firearms}
                createReason={createReason}
                writePhase={writePhase}
                storageBlocked={storageBlocked}
                openCreate={openCreate}
                saveEditor={saveEditor}
                requestClose={requestClose}
                showDetail={showDetail}
                openEdit={openEdit}
                setEditor={setEditor}
                editOptions={editOptions}
                requestToggle={requestToggle}
                toggleReason={toggleReason}
                requestSwitch={requestSwitch}
                counts={counts}
              />
            ))}
          </div>
        </Tabs>
      ) : null}

    <CatalogEditorSurface
      detailOpen={detailOpen}
      editor={editor}
      requestClose={requestClose}
      detailSurfaceKind={detailSurfaceKind}
      detailFocusTarget={detailFocusTarget}
      error={error}
      success={success}
      writePhase={writePhase}
      catalog={catalog}
      firearms={firearms}
      editOptions={editOptions}
      setEditor={setEditor}
      mediaPickerOpen={mediaPickerOpen}
      mediaPickerPurpose={mediaPickerPurpose}
      mediaOptions={mediaOptions}
      mediaOptionsLoading={mediaOptionsLoading}
      mediaOptionsError={mediaOptionsError}
      mediaNextCursor={mediaNextCursor}
      mediaRetryCursor={mediaRetryCursor}
      unbindMedia={unbindMedia}
      dismissMediaPicker={dismissMediaPicker}
      pickMedia={pickMedia}
      loadMediaOptionsPage={loadMediaOptionsPage}
      openMediaPicker={openMediaPicker}
      setDetailOpen={setDetailOpen}
      saveEditor={saveEditor}
      storageBlocked={storageBlocked}
    />
    <CatalogConfirmDialogs
      toggleDraft={toggleDraft}
      setToggleDraft={setToggleDraft}
      toggleLabel={toggleLabel}
      writePhase={writePhase}
      storageBlocked={storageBlocked}
      confirmToggle={confirmToggle}
      closeAsked={closeAsked}
      setCloseAsked={setCloseAsked}
      editor={editor}
      detailFocusTarget={detailFocusTarget}
      changeEditor={changeEditor}
      pendingSwitch={pendingSwitch}
      setPendingSwitch={setPendingSwitch}
      applySwitch={applySwitch}
    />
    </div>
  );
}
