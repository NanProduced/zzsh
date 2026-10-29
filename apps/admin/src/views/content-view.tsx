import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, FolderOpen, Image, Megaphone, Newspaper, Plus, RefreshCw, Search } from "lucide-react";

import {
  adminRequest,
  friendlyError,
  hasPermission,
  type ContentGame,
  type ContentItemDetail,
  type ContentItemRow,
  type ContentItemsPage,
  type ContentMediaOptionsPage,
  type ContentType,
  type SessionSnapshot,
} from "../api";
import { Badge } from "../components/ui/badge";
import { Button, StatusMessage } from "../components/ui-elements";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import type { WorkspaceTab } from "../workspace/tab-model";

import { ContentResourcesTab, ContentStoragePanel } from "./content-resources-tab";
import { contentTime } from "./content-resources-model";
import { ContentSelect } from "./content-resource-fields";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ItemEditor, itemStateLabel } from "./content-item-editor";
import { ContentMediaTab } from "./content-media-tab";

type ContentTab = "rules" | "pages" | "announcement" | "news" | "media";

const TAB_META: Record<ContentTab, { label: string; icon: typeof BookOpen }> = {
  rules: { label: "规则与手册", icon: BookOpen },
  pages: { label: "图片与二维码", icon: Image },
  announcement: { label: "平台公告", icon: Megaphone },
  news: { label: "资讯", icon: Newspaper },
  media: { label: "运营素材", icon: FolderOpen },
};

const CONTENT_TABS = Object.keys(TAB_META) as ContentTab[];

/** 无可用分区时给出可读默认：平台级优先，其次资讯；权限收窄后仍落在允许集合内。 */
function defaultContentTab(available: readonly ContentTab[]): ContentTab {
  return available[0] ?? "announcement";
}

/** 资讯范围的默认与合法值都取决于当前权限，避免先渲染无权分区。 */
function defaultNewsScope(canPlatformRead: boolean): "platform" | "game" {
  return canPlatformRead ? "platform" : "game";
}

function allowedNewsScope(value: string | undefined, canPlatformRead: boolean, canGameRead: boolean): "platform" | "game" | null {
  if (value === "platform") return canPlatformRead ? "platform" : null;
  if (value === "game") return canGameRead ? "game" : null;
  return null;
}

/** 地址栏分区必须属于当前可访问分区集合；资讯另需范围合法，否则按权限默认。 */
function allowedContentTab(value: string | undefined, available: readonly ContentTab[]): ContentTab | null {
  if (value === "carousel") value = "pages";
  if (!value || !CONTENT_TABS.includes(value as ContentTab) || !available.includes(value as ContentTab)) return null;
  return value as ContentTab;
}

function itemStateTone(item: ContentItemRow): "success" | "info" | "warning" | "unknown" {
  if (item.published) return "success";
  if (item.draft) return "info";
  if (item.latest) return "warning";
  return "unknown";
}

export function ContentView({
  snapshot,
  onDirtyChange,
  onWriteLockChange,
  refreshNonce,
  tab: workspaceTab,
  onQueryChange,
  onOpenPath,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
  refreshNonce: number;
  tab?: WorkspaceTab;
  onQueryChange?: (query: Record<string, string>) => void;
  onOpenPath?: (path: string) => void;
}) {
  const canPlatformRead = hasPermission(snapshot, "content.platform.read");
  const canPlatformEdit = hasPermission(snapshot, "content.platform.edit");
  const canPlatformPublish = hasPermission(snapshot, "content.platform.publish");
  const canGameRead = hasPermission(snapshot, "content.read");
  const canGameEdit = hasPermission(snapshot, "content.edit");
  const canGamePublish = hasPermission(snapshot, "content.publish");

  const availableTabs: ContentTab[] = [
    ...(canPlatformRead || canGameRead ? (["rules"] as const) : []),
    ...(canPlatformRead ? (["pages"] as const) : []),
    ...(canPlatformRead ? (["announcement"] as const) : []),
    ...(canPlatformRead || canGameRead ? (["news"] as const) : []),
    ...(canPlatformRead ? (["media"] as const) : []),
  ];
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
  const [detailError, setDetailError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
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
  const reportDirty = useCallback((dirty: boolean) => { contentDirty.current = dirty; onDirtyChange(dirty); }, [onDirtyChange]);
  const reportWriteLock = useCallback((locked: boolean) => {
    if (!contentMounted.current) return;
    writeLockedRef.current = locked; setWriteLocked(locked); onWriteLockChange?.(locked);
  }, [onWriteLockChange]);
  useLayoutEffect(() => { contentMounted.current = true; return () => { contentMounted.current = false; onWriteLockChange?.(false); }; }, [onWriteLockChange]);
  const chooseTab = (value: ContentTab) => {
    if (value === tab || writeLockedRef.current) return;
    if (contentDirty.current) { setTabIntent(() => () => { setTab(value); setDetail(null); setMessage(undefined); setActionError(undefined); }); return; }
    setTab(value); setDetail(null); setMessage(undefined); setActionError(undefined);
  };

  const itemTab = tab === "announcement" || tab === "news";
  const itemType: ContentType = tab === "announcement" ? "ANNOUNCEMENT" : "NEWS";
  const itemScope = tab === "announcement" ? "platform" : newsScope;
  const itemCanEdit = itemScope === "platform" ? canPlatformEdit : canGameEdit;
  const itemCanPublish = itemScope === "platform" ? canPlatformPublish : canGamePublish;

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
    void loadGames();
  }, [loadGames, refreshNonce]);

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
    if (!notify) return;
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
  }, [externalKey, syncedKey, url, pendingGameScope, canPlatformRead, canGameRead, tab, newsScope, gameId]);

  const listQuery = useCallback((): string => {
    const params = new URLSearchParams({ scope: itemScope, type: itemType, limit: "20" });
    if (itemScope === "game") params.set("gameId", gameId);
    return params.toString();
  }, [gameId, itemScope, itemType]);

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
      setDetailError(friendlyError(failure));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    await loadList(cursorTrail[pageIndex] ?? null);
    if (detail) await openItem(detail.item.id);
  }, [detail, loadList, openItem, cursorTrail, pageIndex]);

  useEffect(() => {
    if (writeLockedRef.current) return;
    if (!itemTab || availableTabs.length === 0) return;
    if (itemScope === "game" && !gameId) {
      setPage({ items: [], nextCursor: null, limit: 20 });
      return;
    }
    setDetail(null);
    detailSeq.current += 1;
    setItemSearch("");
    setItemFilter("all");
    setCursorTrail([null]);
    setPageIndex(0);
    void loadList(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemTab, itemScope, itemType, gameId, refreshNonce, loadList, availableTabs.length]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const createItem = async () => {
    if (writeLockedRef.current) return;
    reportWriteLock(true);
    setCreating(true);
    setActionError(undefined);
    setMessage(undefined);
    try {
      const body: Record<string, unknown> = { type: itemType, updateSettings: { format: "markdown" } };
      if (itemScope === "game") body.gameId = gameId;
      if (createTitle.trim()) body.title = createTitle.trim();
      const created = await adminRequest<{ item: ContentItemRow }>("/content/items", body);
      setCreateTitle("");
      setCreateOpen(false);
      setMessage(itemType === "ANNOUNCEMENT" ? "公告草稿已创建。" : "资讯草稿已创建。");
      resetList();
      await openItem(created.item.id);
    } catch (failure) {
      setActionError(friendlyError(failure));
    } finally {
      setCreating(false);
      reportWriteLock(false);
    }
  };

  const requestMediaOptions = useCallback(async (cursor: string | null): Promise<ContentMediaOptionsPage> => {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return adminRequest<ContentMediaOptionsPage>(`/content/media-options?${params.toString()}`);
  }, []);

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

  return (
    <div className="content-management content-workspace">
      <section className="section-panel content-shell">
        <div className="content-heading content-shell-head"><div><h3 className="text-lg font-semibold">内容管理</h3><p className="mt-1 text-sm text-muted-foreground">维护帮助、页面图片与平台动态。</p></div>
        <nav className="content-tabs" role="tablist" aria-label="内容管理分区">
          {availableTabs.map((value) => {
            const meta = TAB_META[value];
            const Icon = meta.icon;
            return <button key={value} type="button" role="tab" aria-selected={tab === value} disabled={writeLocked} className="content-tab" onClick={() => chooseTab(value)}><Icon size={15} aria-hidden="true" /><span>{meta.label}</span></button>;
          })}
        </nav></div>
        <StatusMessage error={actionError || (!detail && detailError ? `读取内容详情失败：${detailError} 请重新打开内容重试。` : undefined)} success={message} className="mt-3" />
      </section>

      {itemTab && !detail && !detailLoading ? (
        <section className="section-panel content-list-panel">
          <div className="content-heading"><div><h3 className="text-base font-semibold">{tab === "announcement" ? "平台公告" : "资讯"}</h3><p className="mt-1 text-sm text-muted-foreground">{tab === "announcement" ? "发布到平台动态；长期规则请放入帮助手册。" : "有时效的资讯与服务更新。"}</p></div><div className="content-heading-meta">{!itemCanEdit ? <Badge variant="unknown">只读</Badge> : null}<Button type="button" size="sm" disabled={!itemCanEdit || (itemScope === "game" && !gameId)} onClick={() => setCreateOpen(true)}><Plus size={14} aria-hidden="true" />新建{ITEM_NOUN[itemType]}</Button></div></div>
            <div className="content-toolbar content-item-toolbar">
              <div className="content-search"><Search size={15} aria-hidden="true" /><Input aria-label="在当前页筛选标题或编号" value={itemSearch} placeholder="筛选本页标题或编号" onChange={event => setItemSearch(event.target.value)} /></div>
              {tab === "news" && canGameRead ? <label className="content-inline-field"><span>范围</span><ContentSelect ariaLabel="资讯范围" value={newsScope} disabled={listLoading || writeLocked} onChange={(next) => { if (!writeLockedRef.current) setNewsScope(next as "platform" | "game"); }} options={[...(canPlatformRead ? [{ value: "platform", label: "平台资讯" }] : []), { value: "game", label: "游戏资讯" }]} className="min-w-32" /></label> : null}
              {tab === "news" && newsScope === "game" ? <label className="content-inline-field"><span>游戏</span><ContentSelect ariaLabel="游戏范围" value={gameId} disabled={listLoading || writeLocked} onChange={next => { if (!writeLockedRef.current) setGameId(next); }} options={games.length ? games.map((game) => ({ value: game.id, label: `${game.name}（${game.code}）` })) : [{ value: "", label: "没有可用游戏范围" }]} className="min-w-40" /></label> : null}
              <Button type="button" size="sm" variant="ghost" loading={listLoading} onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
              <div className="content-state-filter" role="group" aria-label="按状态筛选本页">{itemChips.map(chip => <Button key={chip.value} type="button" size="sm" variant={itemFilter === chip.value ? "secondary" : "ghost"} aria-pressed={itemFilter === chip.value} onClick={() => setItemFilter(chip.value)}>{chip.label}<span className="content-state-count">{chip.count}</span></Button>)}</div>
            </div>
            <StatusMessage error={listError} className="mt-3" />
            {page && filteredItems.length > 0 ? (
              <div className="table-wrap mt-3">
                <table className="data-table content-item-table">
                  <thead><tr><th>标题</th><th>范围</th><th>状态</th><th>发布时间 / 更新</th><th /></tr></thead>
                  <tbody>
                    {filteredItems.map((item) => {
                      const title = item.published?.title || item.draft?.title || item.latest?.title || "（无标题）";
                      return <tr key={item.id}>
                        <td className="max-w-sm"><span className="content-item-title">{title}</span><span className="content-item-id">{item.id}</span></td>
                        <td>{item.gameId === null ? "平台" : item.gameName ?? item.gameId}</td>
                        <td><Badge variant={itemStateTone(item)}>{itemStateLabel(item)}</Badge><span className="content-item-sub">{item.published ? `线上 v${item.published.sequence}` : item.draft ? `草稿 v${item.draft.sequence} 未发布` : item.latest ? `历史 v${item.latest.sequence}` : "无版本"}{item.published && item.draft ? ` · 草稿 v${item.draft.sequence} 待发布` : ""}</span></td>
                        <td className="text-[11px]"><span className="block">{item.published?.publishedAt ? `发布 ${contentTime(item.published.publishedAt)}` : "尚未发布"}</span><span className="block text-muted-foreground">更新 {contentTime(item.updatedAt)}</span></td>
                        <td><Button type="button" size="sm" variant="secondary" onClick={() => void openItem(item.id)}>{itemCanEdit ? "编辑" : "查看"}</Button></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground py-6 text-center">{listLoading ? "加载中…" : itemSearch || itemFilter !== "all" ? "本页没有匹配的内容；可翻页或调整筛选。" : "当前筛选下没有内容。"}</p>
            )}
            <div className="content-pager" aria-label="公告资讯分页"><span>第 {pageIndex + 1} 页 · 本页 {items.length} 条 · 按更新时间倒序</span><div><Button type="button" size="sm" variant="secondary" disabled={pageIndex === 0 || listLoading} onClick={previousPage}>上一页</Button><Button type="button" size="sm" variant="secondary" disabled={!page?.nextCursor || listLoading} onClick={nextPage}>下一页</Button></div></div>
        </section>
      ) : null}

      {itemTab && detail ? (
        <>
          {detailError ? <StatusMessage error={`详情刷新失败；当前编辑内容保持不变。${detailError}`} /> : null}
          <ItemEditor
            key={`${detail.item.id}:${detail.item.revision}:${detail.item.draft?.id ?? "none"}:${detailReadVersion}`}
            detail={detail}
            reading={detailLoading}
            games={games}
            canEdit={itemCanEdit}
            canPublish={itemCanPublish}
            canPublishPlatform={canPlatformPublish}
            mediaReadable={canPlatformRead}
            onClose={() => { if (writeLockedRef.current) return; setDetail(null); reportDirty(false); void loadList(cursorTrail[pageIndex] ?? null); }}
            onChanged={reload}
            onDirtyChange={reportDirty}
            onWriteLockChange={reportWriteLock}
            requestMediaOptions={requestMediaOptions}
            onReload={() => { if (!writeLockedRef.current) void openItem(detail.item.id, true); }}
            onSuccess={setMessage}
          />
        </>
      ) : itemTab && detailLoading ? <section className="section-panel text-xs text-muted-foreground" role="status">加载内容详情…</section> : null}

      {tab === "rules" || tab === "pages" ? <ContentResourcesTab key={`${tab}:${snapshot.adminUserId}:${snapshot.session.id}:${canPlatformRead}:${canGameRead}`} group={tab} snapshot={snapshot} games={games} refreshNonce={refreshNonce} onDirtyChange={reportDirty} onWriteLockChange={reportWriteLock} /> : null}
      {tab === "rules" ? <details className="section-panel text-sm"><summary className="cursor-pointer text-muted-foreground">业务规则维护入口</summary><div className="mt-3 space-y-3"><p className="text-muted-foreground leading-relaxed">出租协议、包赔条款、价目与租期在“规则与价目”维护。这里的服务说明不会改变本单报价和已确认条款。</p>{onOpenPath && hasPermission(snapshot, "supply.rules.edit") ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenPath("/supply/rules")}>打开规则与价目</Button> : <p className="text-muted-foreground">维护业务参数需要规则编辑权限。</p>}</div></details> : null}

      {tab === "media" ? <><ContentStoragePanel /><ContentMediaTab canEdit={canPlatformEdit} canPublish={canPlatformPublish} refreshNonce={refreshNonce} onWriteLockChange={reportWriteLock} /></> : null}
      <Dialog open={createOpen} onOpenChange={open => { if (!creating) setCreateOpen(open); }}><DialogContent><DialogTitle>新建{ITEM_NOUN[itemType]}</DialogTitle><DialogDescription>先创建草稿；保存并发布后进入平台动态。</DialogDescription><Field label={`新建${ITEM_NOUN[itemType]}标题（可留空后编辑）`}><Input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} maxLength={200} autoFocus disabled={!itemCanEdit || creating} /></Field><DialogFooter><Button type="button" variant="secondary" disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button><Button type="button" loading={creating} disabled={!itemCanEdit || (itemScope === "game" && !gameId)} onClick={() => void createItem()}>创建草稿</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={tabIntent !== null} onOpenChange={open => { if (!open) setTabIntent(null); }}><DialogContent role="alertdialog"><DialogTitle>离开当前内容？</DialogTitle><DialogDescription>未保存修改将丢失。结果待核对的请求会保留，回到对应内容后继续核对。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setTabIntent(null)}>继续编辑</Button><Button type="button" variant="danger" onClick={() => { if (writeLockedRef.current) return; const action = tabIntent; setTabIntent(null); reportDirty(false); action?.(); }}>离开当前内容</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

const ITEM_NOUN: Record<ContentType, string> = { ANNOUNCEMENT: "公告", NEWS: "资讯" };
