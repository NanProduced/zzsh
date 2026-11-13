import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import {
  adminRequest,
  AdminApiError,
  friendlyError,
  hasPermission,
  type ContentGame,
  type ContentItemDetail,
  type ContentItemRow,
  type ContentItemsPage,
  type ContentType,
  type ContentVersionRow,
  type SessionSnapshot,
} from "../api";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import type { WorkspaceTab } from "../workspace/tab-model";

import { ContentResourcesTab, ContentStoragePanel } from "./content-resources-tab";
import { ContentHelpTree } from "./content-help-tree";
import { ItemEditor } from "./content-item-editor";
import { ContentItemList } from "./content-item-list";
import { ContentViewDialogs } from "./content-view-dialogs";
import { ITEM_NOUN, TAB_META, SURFACE_TABS, CONTENT_TABS, allowedContentTab, allowedNewsScope, defaultContentTab, defaultNewsScope, type ContentSurface, type ContentTab } from "./content-view-tabs";
import { ContentMediaTab } from "./content-media-tab";
import { LegalDocumentsPanel } from "./legal-documents-panel";
import { PlateTrialTab } from "./plate-trial-tab";
import "./content-updates.css";

function itemWithSavedDraft(item: ContentItemRow, draft: ContentVersionRow): ContentItemRow {
  if (item.id !== draft.itemId || item.draft?.id !== draft.id) return item;
  return { ...item, draft, latest: !item.latest || item.latest.id === draft.id ? draft : item.latest, updatedAt: draft.updatedAt };
}

export function ContentView({
  snapshot,
  onDirtyChange,
  onWriteLockChange,
  refreshNonce,
  tab: workspaceTab,
  onQueryChange,
  onOpenPath,
  surface,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
  refreshNonce: number;
  tab?: WorkspaceTab;
  onQueryChange?: (query: Record<string, string>) => void;
  onOpenPath?: (path: string) => void;
  surface?: ContentSurface;
}) {
  const canPlatformRead = hasPermission(snapshot, "content.platform.read");
  const canPlatformEdit = hasPermission(snapshot, "content.platform.edit");
  const canPlatformPublish = hasPermission(snapshot, "content.platform.publish");
  const canPlatformUpdatePublish = canPlatformPublish || hasPermission(snapshot, "content.updates.publish");
  const canHelpRead = canPlatformRead || hasPermission(snapshot, "content.help.read");
  const canLegalRead = hasPermission(snapshot, "supply.rules.edit") || canPlatformRead || canPlatformEdit || canPlatformPublish || hasPermission(snapshot, "content.fixed.submit") || hasPermission(snapshot, "content.fixed.publish");
  const canGameRead = hasPermission(snapshot, "content.read");
  const canGameEdit = hasPermission(snapshot, "content.edit");
  const canGamePublish = hasPermission(snapshot, "content.publish");

  const permittedTabs: ContentTab[] = [
    ...(canPlatformRead || canGameRead ? (["rules"] as const) : []),
    ...(canHelpRead ? (["help"] as const) : []),
    ...(canPlatformRead ? (["pages"] as const) : []),
    ...(canPlatformRead ? (["announcement"] as const) : []),
    ...(canPlatformRead || canGameRead ? (["news"] as const) : []),
    ...(canPlatformRead ? (["media"] as const) : []),
    ...(canLegalRead ? (["legal"] as const) : []),
    ...(canPlatformEdit && globalThis.__PLATE_TRIAL_ENABLED__ === true ? (["plate-trial"] as const) : []),
  ];
  const availableTabs = surface ? SURFACE_TABS[surface].filter(value => permittedTabs.includes(value) && (surface !== "help" || value !== "rules" || canGameRead)) : permittedTabs;
  const updatesWorkspace = surface === "updates";
  const [tab, setTab] = useState<ContentTab>(() => allowedContentTab(workspaceTab?.query.tab, availableTabs) ?? defaultContentTab(availableTabs));
  const [newsScope, setNewsScope] = useState<"platform" | "game">(
    allowedNewsScope(workspaceTab?.query.scope, canPlatformRead, canGameRead) ?? defaultNewsScope(canPlatformRead),
  );
  const [gameId, setGameId] = useState(workspaceTab?.query.gameId ?? "");
  const [games, setGames] = useState<ContentGame[]>([]);
  const [page, setPage] = useState<ContentItemsPage | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [detail, setDetail] = useState<ContentItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<{ id: string; message: string }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [newDraftId, setNewDraftId] = useState<string>();
  const createAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [itemSearch, setItemSearch] = useState("");
  const [itemFilter, setItemFilter] = useState<"all" | "published" | "draft" | "withdrawn">("all");
  const [cursorTrail, setCursorTrail] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [writeLocked, setWriteLocked] = useState(false);
  const [detailReadVersion, setDetailReadVersion] = useState(0);
  const writeLockedRef = useRef(false), contentMounted = useRef(true);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const contentDirty = useRef(false);
  const [tabIntent, setTabIntent] = useState<(() => void) | null>(null);
  const clearDetail = useCallback(() => {
    detailSeq.current += 1;
    setDetail(null);
    setDetailLoading(false);
    setDetailError(undefined);
    setNewDraftId(undefined);
  }, []);
  const reportDirty = useCallback((dirty: boolean) => { contentDirty.current = dirty; onDirtyChange(dirty); }, [onDirtyChange]);
  const reportWriteLock = useCallback((locked: boolean) => {
    if (!contentMounted.current) return;
    writeLockedRef.current = locked; setWriteLocked(locked); onWriteLockChange?.(locked);
  }, [onWriteLockChange]);
  useLayoutEffect(() => { contentMounted.current = true; return () => { contentMounted.current = false; onWriteLockChange?.(false); }; }, [onWriteLockChange]);
  const leaveIfDirty = (action: () => void) => {
    if (writeLockedRef.current) return;
    if (contentDirty.current) { setTabIntent(() => action); return; }
    action();
  };
  const chooseTab = (value: ContentTab) => {
    if (value === tab) return;
    leaveIfDirty(() => {
      clearDetail();
      setTab(value);
      setMessage(undefined);
      setActionError(undefined);
    });
  };

  const itemTab = tab === "announcement" || tab === "news";
  const itemType: ContentType = tab === "announcement" ? "ANNOUNCEMENT" : "NEWS";
  const itemScope = tab === "announcement" ? "platform" : newsScope;
  const itemGameId = itemScope === "game" ? gameId : "";
  const itemCanEdit = itemScope === "platform" ? canPlatformEdit : canGameEdit;
  const itemCanPublish = itemScope === "platform" ? canPlatformUpdatePublish : canGamePublish;

  const loadGames = useCallback(async () => {
    if (!canGameRead) return;
    try {
      const result = await adminRequest<{ games: ContentGame[] }>("/content/games");
      setGames(result.games);
      setGameId((current) => (current && result.games.some((game) => game.id === current) ? current : result.games[0]?.id ?? ""));
    } catch (failure) {
      setListError(friendlyError(failure));
    }
  }, [canGameRead]);

  useEffect(() => {
    if (!surface || (updatesWorkspace && tab === "news") || (surface === "help" && tab === "rules")) void loadGames();
  }, [loadGames, refreshNonce, surface, updatesWorkspace, tab]);

  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "announcement");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTabs.join(","), tab]);

  // 地址栏同步只有一处 effect：
  //  · 地址（含 query）与本地一致 → 什么都不做；
  //  · 地址是外部变化（刷新/前后退/带 query 打开）→ 采用地址，不回写；
  //  · 本地分区变化（用户点分区/切范围）→ 写回一次，且只在内容真的不同时才写。
  // 依赖只取基元值（url/externalKey/tab/scope/gameId），父级每次渲染产生的新回调与未变的 query 对象都不会触发重跑。
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  const url = workspaceTab?.path ?? "/content";
  const externalKey = `${url}?${workspaceTab?.query.tab ?? ""}|${workspaceTab?.query.scope ?? ""}|${workspaceTab?.query.gameId ?? ""}`;
  const pendingGameScope = tab === "news" && newsScope === "game" && !gameId;
  const syncedQuery: { tab: ContentTab; scope?: "platform" | "game"; gameId?: string } = tab === "news"
    ? { tab, scope: newsScope, ...(newsScope === "game" && gameId ? { gameId } : {}) }
    : { tab };
  const syncedKey = JSON.stringify(syncedQuery);
  const lastExternal = useRef<string | null>(null);
  useEffect(() => {
    const notify = onQueryChangeRef.current;
    if (!notify || (surface && !updatesWorkspace && surface !== "help")) return;
    const current = workspaceTab?.query ?? {};
    const sameAsLocal = current.tab === syncedQuery.tab
      && (syncedQuery.scope === undefined || current.scope === syncedQuery.scope)
      && (syncedQuery.gameId === undefined || current.gameId === syncedQuery.gameId);
    if (sameAsLocal) {
      lastExternal.current = externalKey;
      return;
    }
    // 地址不是上次已处理过的地址 → 外部导航：采用地址里合法且有权的部分，不回写。
    if (lastExternal.current !== externalKey) {
      if (writeLockedRef.current) { notify(syncedQuery); return; }
      lastExternal.current = externalKey;
      const adoptedTab = allowedContentTab(current.tab, availableTabs);
      const adoptedScope = allowedNewsScope(current.scope, canPlatformRead, canGameRead);
      const changed = (adoptedTab && adoptedTab !== tab) || (adoptedScope && adoptedScope !== newsScope) || (current.gameId !== undefined && current.gameId !== gameId);
      const adopt = () => {
        if (adoptedTab && adoptedTab !== tab) setTab(adoptedTab);
        if (adoptedScope && adoptedScope !== newsScope) setNewsScope(adoptedScope);
        if (current.gameId !== undefined && current.gameId !== gameId) setGameId(current.gameId);
      };
      if (changed && contentDirty.current) { notify(syncedQuery); setTabIntent(() => adopt); return; }
      adopt();
      return;
    }
    // 本地分区变化：写回一次；game 范围尚未拿到 gameId 时等就绪再写，避免写入不完整范围。
    if (pendingGameScope) return;
    notify(syncedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalKey, syncedKey, url, pendingGameScope, canPlatformRead, canGameRead, tab, newsScope, gameId, surface, updatesWorkspace]);

  const listQuery = useCallback((): string => {
    const params = new URLSearchParams({ scope: itemScope, type: itemType, limit: "20" });
    if (itemScope === "game") params.set("gameId", itemGameId);
    return params.toString();
  }, [itemGameId, itemScope, itemType]);

  const loadList = useCallback(async (cursor?: string | null) => {
    const seq = ++listSeq.current;
    setListLoading(true);
    setListError(undefined);
    try {
      const params = listQuery();
      const result = await adminRequest<ContentItemsPage>(`/content/items?${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (seq !== listSeq.current) return;
      setPage(result);
    } catch (failure) {
      if (seq !== listSeq.current) return;
      setListError(friendlyError(failure));
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, [listQuery]);

  const resetList = useCallback(() => {
    setCursorTrail([null]);
    setPageIndex(0);
    setPage(null);
    void loadList(null);
  }, [loadList]);

  const nextPage = () => {
    if (!page?.nextCursor || listLoading) return;
    const trail = [...cursorTrail.slice(0, pageIndex + 1), page.nextCursor];
    setCursorTrail(trail);
    setPageIndex(pageIndex + 1);
    void loadList(page.nextCursor);
  };
  const previousPage = () => {
    if (pageIndex === 0 || listLoading) return;
    const target = cursorTrail[pageIndex - 1] ?? null;
    setPageIndex(pageIndex - 1);
    void loadList(target);
  };

  const openItem = useCallback(async (id: string, replaceWorkingCopy = false) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(undefined);
    setListError(undefined);
    try {
      const result = await adminRequest<ContentItemDetail>(`/content/items/${id}`);
      if (seq !== detailSeq.current) return;
      setDetail(result);
      if (replaceWorkingCopy) setDetailReadVersion(value => value + 1);
    } catch (failure) {
      if (seq !== detailSeq.current) return;
      setDetailError({ id, message: friendlyError(failure) });
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    await loadList(cursorTrail[pageIndex] ?? null);
    if (detail) await openItem(detail.item.id);
  }, [detail, loadList, openItem, cursorTrail, pageIndex]);

  const updateAfterWrite = useCallback(async (savedDraft?: ContentVersionRow) => {
    if (!savedDraft) { await reload(); return; }
    setDetail(current => current?.item.draft?.id !== savedDraft.id ? current : {
      item: itemWithSavedDraft(current.item, savedDraft),
      versions: current.versions.map(version => version.id === savedDraft.id ? savedDraft : version),
    });
    setPage(current => current ? { ...current, items: current.items.map(item => itemWithSavedDraft(item, savedDraft)) } : current);
  }, [reload]);

  const listContext = itemTab ? `${itemScope}|${itemType}|${itemGameId}` : "";
  const loadedContext = useRef("");
  useEffect(() => {
    if (writeLockedRef.current) return;
    if (loadedContext.current !== listContext) {
      loadedContext.current = listContext;
      clearDetail();
      listSeq.current += 1;
      setPage(null);
      setListLoading(false);
      setListError(undefined);
      setItemSearch("");
      setItemFilter("all");
    }
    if (!itemTab || availableTabs.length === 0 || (itemScope === "game" && !itemGameId)) return;
    resetList();
  }, [availableTabs.length, clearDetail, itemGameId, itemScope, itemTab, listContext, refreshNonce, resetList]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const createItem = async () => {
    if (writeLockedRef.current || !itemCanEdit || (itemScope === "game" && !itemGameId)) return;
    const body: Record<string, unknown> = { type: itemType, updateSettings: { format: "plate" } };
    if (itemScope === "game") body.gameId = itemGameId;
    if (createTitle.trim()) body.title = createTitle.trim();
    const fingerprint = JSON.stringify(body);
    if (createAttempt.current && createAttempt.current.fingerprint !== fingerprint) {
      setActionError("上次新建结果待核对。请回到原分区重试。");
      return;
    }
    const attempt = createAttempt.current ?? { fingerprint, key: `idem_${crypto.randomUUID().replaceAll("-", "")}` };
    createAttempt.current = attempt;
    reportWriteLock(true);
    setCreating(true);
    setActionError(undefined);
    setMessage(undefined);
    try {
      const created = await adminRequest<{ item: ContentItemRow }>("/content/items", body, "POST", { "idempotency-key": attempt.key });
      createAttempt.current = null;
      setNewDraftId(created.item.id);
      setCreateTitle("");
      setCreateOpen(false);
      setMessage(itemType === "ANNOUNCEMENT" ? "公告草稿已创建。" : "资讯草稿已创建。");
      resetList();
      await openItem(created.item.id);
    } catch (failure) {
      if (failure instanceof AdminApiError && failure.status >= 400 && failure.status < 500 && failure.code !== "IDEMPOTENCY_KEY_REUSED") {
        createAttempt.current = null;
      }
      setActionError(createAttempt.current ? "新建结果待核对。重试会复用原请求。" : friendlyError(failure));
    } finally {
      setCreating(false);
      reportWriteLock(false);
    }
  };


  if (availableTabs.length === 0) {
    return (
      <section className="section-panel">
        <StatusMessage tone="warning" error="当前账号没有内容管理权限。平台级内容与游戏级内容需要不同的动态操作权限。" />
      </section>
    );
  }

  const items = page?.items ?? [];
  const searchedItems = items.filter(item => {
    const title = item.published?.title || item.draft?.title || item.latest?.title || "";
    return `${title} ${item.id}`.toLowerCase().includes(itemSearch.toLowerCase());
  });
  const itemMatches = (item: ContentItemRow, value: typeof itemFilter) => value === "all"
    || (value === "published" ? Boolean(item.published) : value === "draft" ? Boolean(item.draft) : Boolean(item.latest && !item.published && !item.draft));
  const filteredItems = searchedItems.filter(item => itemMatches(item, itemFilter));
  const itemChips = ([["all", "全部"], ["published", "已发布"], ["draft", "草稿"], ["withdrawn", "已撤回"]] as const).map(([value, label]) => ({ value, label, count: value === "all" ? searchedItems.length : searchedItems.filter(item => itemMatches(item, value)).length }));

  const tabList = (
    <nav className="content-tabs" role="tablist" aria-label={updatesWorkspace ? "平台动态分区" : "内容管理分区"}>
      {availableTabs.map((value) => {
        const meta = TAB_META[value];
        const Icon = meta.icon;
        return <button key={value} type="button" role="tab" aria-selected={tab === value} disabled={writeLocked} className="content-tab" onClick={() => chooseTab(value)}>
          {!updatesWorkspace ? <Icon size={15} aria-hidden="true" /> : null}<span>{updatesWorkspace && value === "announcement" ? "公告" : meta.label}</span>
        </button>;
      })}
    </nav>
  );
  const newItem = itemCanEdit ? <Button type="button" size="sm" variant={updatesWorkspace ? "outline" : "default"} loading={creating}
    disabled={writeLocked || (itemScope === "game" && !itemGameId)}
    onClick={() => leaveIfDirty(() => { if (updatesWorkspace) void createItem(); else setCreateOpen(true); })}>
    <Plus size={14} aria-hidden="true" />新建{ITEM_NOUN[itemType]}
  </Button> : null;
  const selectItem = (id: string) => {
    if (detail?.item.id === id) return;
    leaveIfDirty(() => { setNewDraftId(undefined); void openItem(id); });
  };
  const retryDetail = detailError ? <Button type="button" size="sm" variant="outline" disabled={writeLocked || detailLoading}
    onClick={() => leaveIfDirty(() => void openItem(detailError.id, detailError.id === detail?.item.id))}>重试详情</Button> : null;
  const workspaceMessage = <>
    <StatusMessage error={actionError || (!detail && detailError ? `读取详情失败。${detailError.message}` : undefined)} success={message} className="mt-3" />
    {updatesWorkspace && !detail ? retryDetail : null}
  </>;
  const itemList = itemTab ? (
    <ContentItemList
      updatesWorkspace={updatesWorkspace}
      itemType={itemType}
      listLoading={listLoading}
      tabList={tabList}
      tab={tab}
      itemCanEdit={itemCanEdit}
      newItem={newItem}
      detail={detail}
      workspaceMessage={workspaceMessage}
      itemSearch={itemSearch}
      setItemSearch={setItemSearch}
      writeLocked={writeLocked}
      loadList={loadList}
      cursorTrail={cursorTrail}
      pageIndex={pageIndex}
      canGameRead={canGameRead}
      canPlatformRead={canPlatformRead}
      newsScope={newsScope}
      leaveIfDirty={leaveIfDirty}
      setNewsScope={setNewsScope}
      gameId={gameId}
      setGameId={setGameId}
      games={games}
      itemChips={itemChips}
      itemFilter={itemFilter}
      setItemFilter={setItemFilter}
      listError={listError}
      page={page}
      filteredItems={filteredItems}
      selectItem={selectItem}
      itemScope={itemScope}
      itemGameId={itemGameId}
      items={items}
      previousPage={previousPage}
      nextPage={nextPage}
    />
  ) : null;

  const itemEditor = itemTab && detail ? (
        <>
          {detailError ? <div className="px-3 pt-3">
            <StatusMessage error={`读取详情失败，当前编辑内容已保留。${detailError.message}`} />
            {updatesWorkspace ? retryDetail : null}
          </div> : null}
          <ItemEditor
            key={`${detail.item.id}:${detail.item.revision}:${detail.item.draft?.id ?? "none"}:${detailReadVersion}`}
            detail={detail}
            reading={detailLoading}
            games={games}
            canEdit={itemCanEdit}
            canPublish={itemCanPublish}
            canPublishPlatform={canPlatformPublish}
            canUploadMedia={canPlatformEdit}
            mediaReadable={canPlatformRead}
            embedded={updatesWorkspace}
            focusTitle={detail.item.id === newDraftId}
            onClose={() => { if (writeLockedRef.current) return; clearDetail(); reportDirty(false); }}
            onChanged={updateAfterWrite}
            onDirtyChange={reportDirty}
            onWriteLockChange={reportWriteLock}
            onReload={() => { if (!writeLockedRef.current) void openItem(detail.item.id, true); }}
            onSuccess={setMessage}
          />
        </>
  ) : itemTab && detailLoading ? <p className="content-updates-empty text-xs text-muted-foreground" role="status">加载内容详情…</p> : null;

  return (
    <div className="content-management content-workspace">
      {!surface ? <section className="section-panel content-shell">
        <div className="content-heading content-shell-head">
          <div><h3 className="text-lg font-semibold">内容管理</h3><p className="mt-1 text-sm text-muted-foreground">{TAB_META[tab].helper}</p></div>
          {tabList}
        </div>
        {workspaceMessage}
      </section> : null}

      {updatesWorkspace ? <div className="content-updates" data-open={Boolean(detail || detailLoading)}>
        {itemList}
        <div className="content-updates-detail">
          {detail && (actionError || message) ? <div className="px-3">{workspaceMessage}</div> : null}
          {itemEditor ?? (filteredItems.length ? <p className="content-updates-empty">选择一条{ITEM_NOUN[itemType]}打开正文</p> : null)}
        </div>
      </div> : itemEditor ?? itemList}

      {surface === "help" && tab === "rules" && canHelpRead ? <Button type="button" size="sm" variant="ghost" disabled={writeLocked} onClick={() => chooseTab("help")}>返回帮助中心</Button> : null}
      {tab === "rules" || tab === "pages" ? <ContentResourcesTab key={`${tab}:${snapshot.adminUserId}:${snapshot.session.id}:${canPlatformRead}:${canGameRead}`} group={tab} gameOnly={surface === "help" && tab === "rules"} snapshot={snapshot} games={games} refreshNonce={refreshNonce} onDirtyChange={reportDirty} onWriteLockChange={reportWriteLock} openResource={tab === "rules" ? workspaceTab?.query.resource : undefined} onOpenMedia={onOpenPath && canPlatformRead ? () => onOpenPath("/content/media") : undefined} /> : null}
      {tab === "rules" && surface !== "help" ? <details className="section-panel text-sm"><summary className="cursor-pointer text-muted-foreground">业务规则维护入口</summary><div className="mt-3 space-y-3"><p className="text-muted-foreground leading-relaxed">出租协议和包赔条款在「协议条款」维护。价目、租期与版本生效在「规则与价目」管理。</p>{onOpenPath && hasPermission(snapshot, "supply.rules.edit") ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenPath("/supply/rules")}>打开规则与价目</Button> : <p className="text-muted-foreground">维护业务参数需要规则编辑权限。</p>}</div></details> : null}

      {tab === "help" ? <>
        {surface === "help" && canGameRead ? <div className="flex justify-end"><Button type="button" size="sm" variant="ghost" disabled={writeLocked} onClick={() => chooseTab("rules")}>游戏手册</Button></div> : null}
        <ContentHelpTree snapshot={snapshot} refreshNonce={refreshNonce} onDirtyChange={reportDirty} onWriteLockChange={reportWriteLock} />
      </> : null}
      {tab === "media" ? <><ContentMediaTab canEdit={canPlatformEdit} canPublish={canPlatformPublish} refreshNonce={refreshNonce} onWriteLockChange={reportWriteLock} onOpenPages={onOpenPath ? () => onOpenPath("/content/pages") : undefined} /><ContentStoragePanel /></> : null}
      {tab === "legal" ? <LegalDocumentsPanel snapshot={snapshot} onDirtyChange={reportDirty} onWriteLockChange={reportWriteLock}
        refreshNonce={refreshNonce} onOpenPath={onOpenPath}
        tradeKind={workspaceTab?.query.trade === "agreement" || workspaceTab?.query.trade === "full_payout_terms" ? workspaceTab.query.trade : undefined}
        tradeGame={workspaceTab?.query.gameId} tradeVersion={workspaceTab?.query.version}
        onTradeSection={kind => {
          const query = { ...workspaceTab?.query };
          delete query.trade; delete query.gameId; delete query.version;
          if (kind) query.trade = kind;
          onQueryChange?.(query);
        }} /> : null}
      {tab === "plate-trial" ? <PlateTrialTab /> : null}
      <ContentViewDialogs
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        creating={creating}
        itemType={itemType}
        createTitle={createTitle}
        setCreateTitle={setCreateTitle}
        itemCanEdit={itemCanEdit}
        itemScope={itemScope}
        gameId={gameId}
        createItem={() => void createItem()}
        tabIntent={tabIntent}
        setTabIntent={setTabIntent}
        itemTab={itemTab}
        writeLockedRef={writeLockedRef}
        reportDirty={reportDirty}
      />
    </div>
  );
}

