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

import { CarouselTab } from "./content-carousel-tab";
import { ItemEditor, itemStateLabel } from "./content-item-editor";
import { ContentMediaTab } from "./content-media-tab";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs";

type ContentTab = "announcement" | "news" | "carousel" | "media";

const TAB_LABELS: Record<ContentTab, string> = {
  announcement: "平台公告",
  news: "资讯",
  carousel: "首页轮播",
  media: "平台素材",
};

export function ContentView({
  snapshot,
  onDirtyChange,
  refreshNonce,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onDirtyChange: (dirty: boolean) => void;
  refreshNonce: number;
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
  const [tab, setTab] = useState<ContentTab>(availableTabs[0] ?? "announcement");
  const [newsScope, setNewsScope] = useState<"platform" | "game">(canPlatformRead ? "platform" : "game");
  const [gameId, setGameId] = useState("");
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
                  <select value={newsScope} onChange={(event) => setNewsScope(event.target.value as "platform" | "game")} className={selectClass}>
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
