import { useCallback, useEffect, useRef, useState } from "react";

import {
  adminRequest,
  formatDate,
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
import { Button, StatusMessage } from "../components/ui-elements";
import type { WorkspaceTab } from "../workspace/tab-model";

import { CarouselTab } from "./content-carousel-tab";
import { ItemEditor, itemStateLabel } from "./content-item-editor";
import { ContentMediaTab } from "./content-media-tab";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 rounded border border-border bg-surface-raised text-xs px-2";

type ContentTab = "announcement" | "news" | "carousel" | "media";

const TAB_LABELS: Record<ContentTab, string> = {
  announcement: "平台公告",
  news: "资讯",
  carousel: "首页轮播",
  media: "平台素材",
};

const CONTENT_TABS = Object.keys(TAB_LABELS) as ContentTab[];

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
  if (!value || !CONTENT_TABS.includes(value as ContentTab) || !available.includes(value as ContentTab)) return null;
  return value as ContentTab;
}

export function ContentView({
  snapshot,
  onDirtyChange,
  refreshNonce,
  tab: workspaceTab,
  onQueryChange,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce: number;
  tab?: WorkspaceTab;
  onQueryChange?: (query: Record<string, string>) => void;
}) {
  const canPlatformRead = hasPermission(snapshot, "content.platform.read");
  const canPlatformEdit = hasPermission(snapshot, "content.platform.edit");
  const canPlatformPublish = hasPermission(snapshot, "content.platform.publish");
  const canGameRead = hasPermission(snapshot, "content.read");
  const canGameEdit = hasPermission(snapshot, "content.edit");
  const canGamePublish = hasPermission(snapshot, "content.publish");
  const canPlatformMedia = canPlatformRead;

  const availableTabs: ContentTab[] = [
    ...(canPlatformRead ? (["announcement"] as const) : []),
    ...(canPlatformRead || canGameRead ? (["news"] as const) : []),
    ...(canPlatformRead ? (["carousel"] as const) : []),
    ...(canPlatformMedia ? (["media"] as const) : []),
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
  const [createTitle, setCreateTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const listSeq = useRef(0);
  const detailSeq = useRef(0);

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
      lastExternal.current = externalKey;
      const adoptedTab = allowedContentTab(current.tab, availableTabs);
      const adoptedScope = allowedNewsScope(current.scope, canPlatformRead, canGameRead);
      if (adoptedTab && adoptedTab !== tab) setTab(adoptedTab);
      if (adoptedScope && adoptedScope !== newsScope) setNewsScope(adoptedScope);
      if (current.gameId !== undefined && current.gameId !== gameId) setGameId(current.gameId);
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

  const loadList = useCallback(async (cursor?: string) => {
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

  const openItem = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setListError(undefined);
    try {
      const result = await adminRequest<ContentItemDetail>(`/content/items/${id}`);
      if (seq !== detailSeq.current) return;
      setDetail(result);
    } catch (failure) {
      if (seq !== detailSeq.current) return;
      setListError(friendlyError(failure));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    await loadList();
    if (detail) await openItem(detail.item.id);
  }, [detail, loadList, openItem]);

  useEffect(() => {
    if (!itemTab) return;
    if (itemScope === "game" && !gameId) {
      setPage({ items: [], nextCursor: null, limit: 20 });
      return;
    }
    setDetail(null);
    detailSeq.current += 1;
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemTab, itemScope, itemType, gameId, refreshNonce, loadList]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const createItem = async () => {
    setCreating(true);
    setActionError(undefined);
    setMessage(undefined);
    try {
      const body: Record<string, unknown> = { type: itemType };
      if (itemScope === "game") body.gameId = gameId;
      if (createTitle.trim()) body.title = createTitle.trim();
      const created = await adminRequest<{ item: ContentItemRow }>("/content/items", body);
      setCreateTitle("");
      setMessage(itemType === "ANNOUNCEMENT" ? "公告已创建为草稿。" : "资讯已创建为草稿。");
      await loadList();
      await openItem(created.item.id);
    } catch (failure) {
      setActionError(friendlyError(failure));
    } finally {
      setCreating(false);
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
        <StatusMessage error="当前账号没有内容管理权限。平台级内容与游戏级内容需要不同的动态操作权限。" />
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="section-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">内容后台</h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              公告与资讯采用草稿/发布版本模型：编辑已发布内容需新建草稿并再次发布；公共接口只返回当前发布版本。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3" role="tablist" aria-label="内容类型">
          {availableTabs.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={tab === value ? "primary" : "secondary"}
              aria-selected={tab === value}
              role="tab"
              onClick={() => {
                setTab(value);
                setDetail(null);
                setMessage(undefined);
                setActionError(undefined);
              }}
            >
              {TAB_LABELS[value]}
            </Button>
          ))}
        </div>
        <StatusMessage error={actionError} success={message} className="mt-3" />
      </section>

      {itemTab ? (
        <>
          <section className="section-panel">
            {tab === "news" && canGameRead ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="space-y-1 text-xs"><span className="text-muted-foreground">资讯范围</span>
                  <select value={newsScope} onChange={(event) => { const next = event.target.value as "platform" | "game"; setNewsScope(next); }} className={selectClass}>
                    {canPlatformRead ? <option value="platform">平台资讯</option> : null}
                    <option value="game">游戏资讯</option>
                  </select>
                </label>
                {newsScope === "game" ? (
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">游戏（按对象范围）</span>
                    <select value={gameId} onChange={(event) => setGameId(event.target.value)} className={selectClass}>
                      {games.length === 0 ? <option value="">没有可用游戏范围</option> : null}
                      {games.map((game) => <option key={game.id} value={game.id}>{game.name}（{game.code}）</option>)}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-3 mt-4">
              <label className="space-y-1 text-xs flex-1 min-w-56">
                <span className="text-muted-foreground">{itemType === "ANNOUNCEMENT" ? "新建公告标题（可留空后编辑）" : "新建资讯标题（可留空后编辑）"}</span>
                <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} className={inputClass} disabled={!itemCanEdit} />
              </label>
              <Button type="button" size="sm" loading={creating} disabled={!itemCanEdit || (itemScope === "game" && !gameId)} onClick={() => void createItem()}>
                新建{ITEM_NOUN[itemType]}
              </Button>
            </div>
            <StatusMessage error={listError} className="mt-3" />
            {page && page.items.length > 0 ? (
              <div className="table-wrap mt-3">
                <table className="data-table">
                  <thead><tr><th>标题</th><th>范围</th><th>状态</th><th>排序</th><th>更新时间</th><th /></tr></thead>
                  <tbody>
                    {page.items.map((item) => (
                      <tr key={item.id}>
                        <td className="max-w-sm">
                          <span className="block truncate">{item.published?.title || item.draft?.title || item.latest?.title || "（无标题）"}</span>
                          <span className="block font-mono text-[10px] text-muted-foreground">{item.id}</span>
                        </td>
                        <td>{item.gameId === null ? "平台" : item.gameName ?? item.gameId}</td>
                        <td>{itemStateLabel(item)}</td>
                        <td className="font-mono text-[11px]">{item.sortOrder}</td>
                        <td className="text-[11px]">{formatDate(item.updatedAt)}</td>
                        <td><Button type="button" size="sm" variant="secondary" onClick={() => void openItem(item.id)}>{itemCanEdit ? "编辑" : "查看"}</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground py-6 text-center">{listLoading ? "加载中…" : "当前筛选下没有内容。"}</p>
            )}
            <div className="flex justify-end mt-4">
              <Button type="button" size="sm" variant="secondary" disabled={!page?.nextCursor || listLoading} onClick={() => { if (page?.nextCursor) void loadList(page.nextCursor); }}>下一页</Button>
            </div>
          </section>

          {detail ? (
            <ItemEditor
              key={`${detail.item.id}:${detail.item.revision}:${detail.item.draft?.id ?? "none"}`}
              detail={detail}
              games={games}
              canEdit={itemCanEdit}
              canPublish={itemCanPublish}
              mediaReadable={canPlatformRead}
              onClose={() => { setDetail(null); onDirtyChange(false); }}
              onChanged={reload}
              onDirtyChange={onDirtyChange}
              requestMediaOptions={requestMediaOptions}
            />
          ) : detailLoading ? <section className="section-panel text-xs text-muted-foreground">加载内容详情…</section> : null}
        </>
      ) : null}

      {tab === "carousel" ? (
        <CarouselTab
          canEdit={canPlatformEdit}
          canPublish={canPlatformPublish}
          mediaReadable={canPlatformRead}
          refreshNonce={refreshNonce}
          onDirtyChange={onDirtyChange}
          requestMediaOptions={requestMediaOptions}
        />
      ) : null}

      {tab === "media" ? <ContentMediaTab canEdit={canPlatformEdit} canPublish={canPlatformPublish} refreshNonce={refreshNonce} /> : null}
    </div>
  );
}

const ITEM_NOUN: Record<ContentType, string> = { ANNOUNCEMENT: "公告", NEWS: "资讯" };
