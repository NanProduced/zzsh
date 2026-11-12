import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, FileText, FolderOpen, FolderTree, Image, Megaphone, Newspaper, Plus, RefreshCw, Search } from "lucide-react";

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
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import type { WorkspaceTab } from "../workspace/tab-model";

import { ContentResourcesTab, ContentStoragePanel } from "./content-resources-tab";
import { ContentHelpTree } from "./content-help-tree";
import { contentTime } from "./content-resources-model";
import { ContentSelect } from "./content-resource-fields";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ItemEditor, itemStateLabel } from "./content-item-editor";
import { ContentMediaTab } from "./content-media-tab";
import { LegalDocumentsPanel } from "./legal-documents-panel";
import { PlateTrialTab } from "./plate-trial-tab";
import "./content-updates.css";

type ContentTab = "rules" | "help" | "pages" | "announcement" | "news" | "media" | "legal" | "plate-trial";
type ContentSurface = "help" | "updates" | "legal" | "pages" | "media" | "trial";
const SURFACE_TABS: Record<ContentSurface, readonly ContentTab[]> = {
  help: ["help", "rules"], updates: ["announcement", "news"], legal: ["legal"], pages: ["pages"], media: ["media"], trial: ["plate-trial"],
};

/** 分区顺序与命名即信息架构：规则与手册／帮助目录／图片与二维码／平台公告／资讯／运营素材／法律文书／Plate 试用。每个分区一句 helper 说明。 */
const TAB_META: Record<ContentTab, { label: string; icon: typeof BookOpen; helper: string }> = {
  rules: { label: "规则与手册", icon: BookOpen, helper: "维护面向用户的规则与帮助手册正文；保存草稿不改变线上。" },
  help: { label: "帮助目录", icon: FolderTree, helper: "管理帮助中心的文件夹与文章结构；点击文章在本页直接编辑正文。" },
  pages: { label: "用户站展示", icon: Image, helper: "维护首页轮播、市场海报、联系二维码与网站页脚。" },
  announcement: { label: "平台公告", icon: Megaphone, helper: "发布平台级公告，进入用户端平台动态；长期规则请放入帮助手册。" },
  news: { label: "资讯", icon: Newspaper, helper: "维护有时效的平台与游戏资讯、服务更新。" },
  media: { label: "图片素材", icon: FolderOpen, helper: "上传并审核供文章和用户站使用的图片。" },
  legal: { label: "协议条款", icon: FileText, helper: "维护协议、告知与页面说明，提交审批后发布。" },
  "plate-trial": { label: "Plate 试用", icon: FileText, helper: "Plate 编辑器的试用与验证入口。" },
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
  const canLegalRead = canPlatformRead || canPlatformEdit || canPlatformPublish || hasPermission(snapshot, "content.fixed.submit") || hasPermission(snapshot, "content.fixed.publish");
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
        <section className={updatesWorkspace ? "content-updates-list" : "section-panel content-list-panel"} aria-label={`${ITEM_NOUN[itemType]}列表`} aria-busy={listLoading || undefined}>
          <div className="content-heading content-updates-list-head">
            {updatesWorkspace ? tabList : <div><h3 className="text-base font-semibold">{tab === "announcement" ? "平台公告" : "资讯"}</h3></div>}
            <div className="content-heading-meta">{!itemCanEdit ? <Badge variant="unknown">只读</Badge> : newItem}</div>
          </div>
          {updatesWorkspace && !detail ? workspaceMessage : null}
            <div className="content-toolbar content-item-toolbar">
              <div className="content-search"><Search size={15} aria-hidden="true" /><Input aria-label="在当前页筛选标题或编号" value={itemSearch} placeholder="筛选本页标题或编号" onChange={event => setItemSearch(event.target.value)} /></div>
              <Button type="button" size="sm" variant="ghost" className={updatesWorkspace ? "content-updates-refresh" : undefined} aria-label="刷新列表" title="刷新列表" loading={listLoading} disabled={writeLocked} onClick={() => void loadList(cursorTrail[pageIndex] ?? null)}><RefreshCw size={14} aria-hidden="true" />{!updatesWorkspace ? "刷新" : null}</Button>
              {tab === "news" && canGameRead && (canPlatformRead || !updatesWorkspace) ? <label className="content-inline-field"><span>范围</span><ContentSelect ariaLabel="资讯范围" value={newsScope} disabled={listLoading || writeLocked} onChange={next => { if (next !== newsScope) leaveIfDirty(() => setNewsScope(next as "platform" | "game")); }} options={[...(canPlatformRead ? [{ value: "platform", label: "平台资讯" }] : []), { value: "game", label: "游戏资讯" }]} className="min-w-32" /></label> : null}
              {tab === "news" && newsScope === "game" ? <label className="content-inline-field"><span>游戏</span><ContentSelect ariaLabel="游戏范围" value={gameId} disabled={listLoading || writeLocked} onChange={next => { if (next !== gameId) leaveIfDirty(() => setGameId(next)); }} options={games.length ? games.map((game) => ({ value: game.id, label: `${game.name}（${game.code}）` })) : [{ value: "", label: "没有可用游戏范围" }]} className="min-w-40" /></label> : null}
              <div className="content-state-filter" role="group" aria-label="按状态筛选本页">{itemChips.map(chip => <Button key={chip.value} type="button" size={updatesWorkspace ? "xs" : "sm"} variant={itemFilter === chip.value ? "secondary" : "ghost"} aria-pressed={itemFilter === chip.value} onClick={() => setItemFilter(chip.value)}>{updatesWorkspace && chip.value === "withdrawn" ? "已下线" : chip.label}{!updatesWorkspace && page ? <span className="content-state-count">{chip.count}</span> : null}</Button>)}</div>
            </div>
            <StatusMessage error={listError} className="mt-3" />
            {page && filteredItems.length > 0 ? (
              updatesWorkspace ? (
                <ul className="content-updates-rows">
                  {filteredItems.map(item => <li key={item.id}>
                    <button type="button" className="content-updates-row" aria-current={detail?.item.id === item.id ? "true" : undefined} disabled={writeLocked} onClick={() => selectItem(item.id)}>
                      <span className="content-item-title">{item.draft?.title || item.published?.title || item.latest?.title || "未命名草稿"}</span>
                      <span className="content-updates-row-state">{!item.published && !item.draft && item.latest ? "已下线" : itemStateLabel(item)}{item.published && item.draft ? " · 有草稿" : ""}</span>
                    </button>
                  </li>)}
                </ul>
              ) : (
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
                        <td><Button type="button" size="sm" variant="secondary" disabled={writeLocked} onClick={() => selectItem(item.id)}>{itemCanEdit ? "编辑" : "查看"}</Button></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              )
            ) : (
              !listError ? <p className="text-xs text-muted-foreground py-6 text-center" role="status">{listLoading ? "加载中…" : itemScope === "game" && !itemGameId ? "没有可用游戏范围。" : itemSearch || itemFilter !== "all" ? "本页没有匹配的内容；可翻页或调整筛选。" : "当前筛选下没有内容。"}</p> : null
            )}
            <div className="content-pager" aria-label="公告资讯分页"><span>第 {pageIndex + 1} 页{!updatesWorkspace && page ? ` · 本页 ${items.length} 条` : ""}</span><div><Button type="button" size={updatesWorkspace ? "xs" : "sm"} variant="secondary" disabled={pageIndex === 0 || listLoading || writeLocked} onClick={previousPage}>上一页</Button><Button type="button" size={updatesWorkspace ? "xs" : "sm"} variant="secondary" disabled={!page?.nextCursor || listLoading || writeLocked} onClick={nextPage}>下一页</Button></div></div>
        </section>
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
      {tab === "rules" && surface !== "help" ? <details className="section-panel text-sm"><summary className="cursor-pointer text-muted-foreground">业务规则维护入口</summary><div className="mt-3 space-y-3"><p className="text-muted-foreground leading-relaxed">出租协议、包赔条款、价目与租期在“规则与价目”维护。这里的服务说明不会改变本单报价和已确认条款。</p>{onOpenPath && hasPermission(snapshot, "supply.rules.edit") ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenPath("/supply/rules")}>打开规则与价目</Button> : <p className="text-muted-foreground">维护业务参数需要规则编辑权限。</p>}</div></details> : null}

      {tab === "help" ? <>
        {surface === "help" && canGameRead ? <div className="flex justify-end"><Button type="button" size="sm" variant="ghost" disabled={writeLocked} onClick={() => chooseTab("rules")}>游戏手册</Button></div> : null}
        <ContentHelpTree snapshot={snapshot} refreshNonce={refreshNonce} onDirtyChange={reportDirty} onWriteLockChange={reportWriteLock} />
      </> : null}
      {tab === "media" ? <><ContentMediaTab canEdit={canPlatformEdit} canPublish={canPlatformPublish} refreshNonce={refreshNonce} onWriteLockChange={reportWriteLock} onOpenPages={onOpenPath ? () => onOpenPath("/content/pages") : undefined} /><ContentStoragePanel /></> : null}
      {tab === "legal" ? <LegalDocumentsPanel snapshot={snapshot} onDirtyChange={reportDirty} onWriteLockChange={reportWriteLock} refreshNonce={refreshNonce} onOpenPath={onOpenPath} /> : null}
      {tab === "plate-trial" ? <PlateTrialTab /> : null}
      <Dialog open={createOpen} onOpenChange={open => { if (!creating) setCreateOpen(open); }}><DialogContent><DialogTitle>新建{ITEM_NOUN[itemType]}</DialogTitle><DialogDescription>先创建草稿；保存并发布后进入平台动态。</DialogDescription><Field label={`新建${ITEM_NOUN[itemType]}标题（可留空后编辑）`}><Input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} maxLength={200} autoFocus disabled={!itemCanEdit || creating} /></Field><DialogFooter><Button type="button" variant="secondary" disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button><Button type="button" loading={creating} disabled={!itemCanEdit || (itemScope === "game" && !gameId)} onClick={() => void createItem()}>创建草稿</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={tabIntent !== null} onOpenChange={open => { if (!open) setTabIntent(null); }}><DialogContent role="alertdialog"><DialogTitle>离开当前内容？</DialogTitle><DialogDescription>{itemTab ? "未保存修改将丢失，可以返回继续编辑。" : "未保存修改将丢失。结果待核对的请求会保留，回到对应内容后继续核对。"}</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setTabIntent(null)}>继续编辑</Button><Button type="button" variant="danger" onClick={() => { if (writeLockedRef.current) return; const action = tabIntent; setTabIntent(null); reportDirty(false); action?.(); }}>离开当前内容</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

const ITEM_NOUN: Record<ContentType, string> = { ANNOUNCEMENT: "公告", NEWS: "资讯" };
