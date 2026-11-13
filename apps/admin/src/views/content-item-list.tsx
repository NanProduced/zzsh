import type { ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";
import type { ContentGame, ContentItemDetail, ContentItemRow, ContentItemsPage, ContentType } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Input } from "../components/ui/input";
import { contentTime } from "./content-resources-model";
import { ContentSelect } from "./content-resource-fields";
import { itemStateLabel } from "./content-item-editor";
import { ITEM_NOUN, type ContentTab } from "./content-view-tabs";

function itemStateTone(item: ContentItemRow): "success" | "info" | "warning" | "unknown" {
  if (item.published) return "success";
  if (item.draft) return "info";
  if (item.latest) return "warning";
  return "unknown";
}

export function ContentItemList({
  updatesWorkspace, itemType, listLoading, tabList, tab, itemCanEdit, newItem, detail, workspaceMessage,
  itemSearch, setItemSearch, writeLocked, loadList, cursorTrail, pageIndex, canGameRead, canPlatformRead,
  newsScope, leaveIfDirty, setNewsScope, gameId, setGameId, games, itemChips, itemFilter, setItemFilter,
  listError, page, filteredItems, selectItem, itemScope, itemGameId, items, previousPage, nextPage,
}: {
  updatesWorkspace: boolean;
  itemType: ContentType;
  listLoading: boolean;
  tabList: ReactNode;
  tab: ContentTab;
  itemCanEdit: boolean;
  newItem: ReactNode;
  detail: ContentItemDetail | null;
  workspaceMessage: ReactNode;
  itemSearch: string;
  setItemSearch: (value: string) => void;
  writeLocked: boolean;
  loadList: (cursor?: string | null) => void;
  cursorTrail: readonly (string | null)[];
  pageIndex: number;
  canGameRead: boolean;
  canPlatformRead: boolean;
  newsScope: "platform" | "game";
  leaveIfDirty: (action: () => void) => void;
  setNewsScope: (value: "platform" | "game") => void;
  gameId: string;
  setGameId: (value: string) => void;
  games: readonly ContentGame[];
  itemChips: readonly { value: "all" | "published" | "draft" | "withdrawn"; label: string; count: number }[];
  itemFilter: "all" | "published" | "draft" | "withdrawn";
  setItemFilter: (value: "all" | "published" | "draft" | "withdrawn") => void;
  listError?: string;
  page: ContentItemsPage | null;
  filteredItems: readonly ContentItemRow[];
  selectItem: (id: string) => void;
  itemScope: string;
  itemGameId: string;
  items: readonly ContentItemRow[];
  previousPage: () => void;
  nextPage: () => void;
}) {
  return (
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
  );
}
