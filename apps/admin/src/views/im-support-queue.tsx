"use client";
/**
 * 客服工作台「队列」模块：统一会话目录与咨询筛选队列的展示层。
 * 数据获取、选中恢复与订单群偏好写入仍由 im-support-view.tsx 编排；
 * 统一目录的右键菜单状态内置，切换管理员时清空。
 */
import { useEffect, useState } from "react";
import { BellOff, CalendarClock, Pin, Search, X } from "lucide-react";
import { ProfileImage } from "@zzsh/ui/profile-image";
import { MessageActionMenu, type MessageActionId } from "@zzsh/ui/message-actions";
import { OrderGroupAvatar } from "./order-group-avatar";
import { initialOf } from "./im-support-format";
import { stageToneOf, type QueueRow, type UnifiedRow } from "./im-support-view-model";
import type { OrderGroupPreference } from "./im-support-group-settings";

/** 窄屏（<1100px）显示的咨询筛选队列：待接待 / 我接待中。 */
export function SupportConsultationQueue({ query, onQueryChange, filter, onFilterChange, counts, rows, selectedId, onSelect }: {
  query: string;
  onQueryChange: (value: string) => void;
  filter: "waiting" | "mine";
  onFilterChange: (value: "waiting" | "mine") => void;
  counts: { waiting: number; mine: number };
  rows: QueueRow[];
  selectedId: string | null;
  onSelect: (row: QueueRow) => void;
}) {
  return <aside className="im-wb-queue" aria-label="会话队列">
    <label className="im-wb-search"><Search size={13} /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" /></label>
    <div className="im-wb-filters" role="group" aria-label="队列筛选">
      <button type="button" aria-pressed={filter === "waiting"} onClick={() => onFilterChange("waiting")}>待接待<b>{counts.waiting}</b></button>
      <button type="button" aria-pressed={filter === "mine"} onClick={() => onFilterChange("mine")}>我接待中<b>{counts.mine}</b></button>
    </div>
    <div className="im-wb-rows">
      {rows.length ? rows.map((row) => <button type="button" key={row.id} className="im-wb-row" data-active={selectedId === row.id} aria-current={selectedId === row.id ? "page" : undefined}
        onClick={() => onSelect(row)}>
        <span className="im-wb-row-av" aria-hidden="true"><ProfileImage src={row.consultation?.user?.avatar} fallback={initialOf(row.title)} /></span>
        <span className="im-wb-row-copy"><span className="im-wb-row-top"><b>{row.title}</b><i className="im-wb-tag" data-tone={row.type === "COMPLAINT" ? "warn" : "neutral"}>{row.type === "COMPLAINT" ? "投诉" : "咨询"}</i><time>{row.time}</time></span>
          <span className="im-wb-row-snip">{row.snippet}</span>
          <span className="im-wb-row-foot"><em data-tone={stageToneOf(row.state)}>{row.state}</em>{row.unreadCount > 0 ? <i className="im-wb-unread" aria-label={`${row.unreadCount} 条未读`}>{row.unreadCount > 99 ? "99+" : row.unreadCount}</i> : null}</span></span>
      </button>) : <div className="im-wb-list-empty">{query ? <><strong>当前列表没有匹配会话</strong><span>试试其他关键词。</span></>
        : filter === "waiting" ? <><strong>系统正在分配…</strong><span>新咨询会按在线状态自动分配；异常时由管理岗接管。</span></>
        : <><strong>暂无你接待中的会话</strong><span>从「待接待」接入一条即可开始。</span></>}</div>}
    </div>
  </aside>;
}

/** 宽屏统一目录：咨询、投诉与订单群同一条时间轴，含搜索、类型筛选与订单群右键菜单。 */
export function SupportUnifiedDirectory({ adminUserId, rows, total, searchState, query, onQueryChange, unifiedType, onTypeChange, orderQueueNotice, serverSearchActive, searchLimitReached, orderNextCursor, orderLoadingMore, orderRefreshing, onLoadMore, hiddenOrderCount, onRestoreHidden, section, selectedId, orderSelection, onSelect, preferenceOf, teamIdOf, onOrderAction }: {
  adminUserId: string;
  rows: UnifiedRow[];
  total: number;
  searchState: { q: string; loading: boolean; error: string | null };
  query: string;
  onQueryChange: (value: string) => void;
  unifiedType: "ALL" | "SERVICE" | "COMPLAINT" | "ORDER";
  onTypeChange: (value: "ALL" | "SERVICE" | "COMPLAINT" | "ORDER") => void;
  orderQueueNotice?: string;
  serverSearchActive: boolean;
  searchLimitReached: boolean;
  orderNextCursor: string | null;
  orderLoadingMore: boolean;
  orderRefreshing: boolean;
  onLoadMore: () => void;
  hiddenOrderCount: number;
  onRestoreHidden: () => void;
  section: "consultation" | "orders";
  selectedId: string | null;
  orderSelection: string | null;
  onSelect: (row: UnifiedRow) => void;
  preferenceOf: (orderId: string, teamId?: string | null) => OrderGroupPreference;
  teamIdOf: (orderId: string) => string | null | undefined;
  onOrderAction: (action: MessageActionId, orderId: string, preference: OrderGroupPreference) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; orderId: string; preference: OrderGroupPreference; row: HTMLElement | null } | null>(null);
  useEffect(() => { setMenu(null); }, [adminUserId]);
  return <>
    <aside className="im-wb-unified-queue" aria-label="全部会话" onContextMenu={(event) => { const rowEl = (event.target as Element).closest(".im-wb-row") as HTMLElement | null; event.preventDefault(); if (!rowEl || rowEl.dataset.unifiedKind !== "order") { setMenu(null); return; } event.stopPropagation(); const orderId = rowEl.dataset.orderId; if (!orderId) return; setMenu({ x: event.clientX, y: event.clientY, orderId, preference: preferenceOf(orderId, teamIdOf(orderId)), row: rowEl }); }}>
      <div className="im-wb-unified-head"><strong>全部会话</strong><span>{searchState.loading && searchState.q === query.trim() ? "搜索中…" : total}</span></div>
      <label className="im-wb-search"><Search size={13} /><input value={query} maxLength={64} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); onQueryChange(""); } }} placeholder="搜索用户、订单号、账号或游戏" aria-label="搜索全部会话" />{query ? <button type="button" className="im-wb-search-clear" aria-label="清空搜索" onClick={() => onQueryChange("")}><X size={12} /></button> : null}</label>
      {searchState.error ? <p className="im-wb-order-notice" data-tone="warn" role="status">{searchState.error}</p> : null}
      {searchLimitReached ? <p className="im-wb-order-notice" role="status">匹配结果较多，当前每类最多显示 50 条；请补充关键词继续缩小范围。</p> : null}
      <div className="im-wb-unified-types" role="group" aria-label="会话类型">
        {([["ALL", "全部"], ["SERVICE", "咨询"], ["COMPLAINT", "投诉"], ["ORDER", "订单群"]] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={unifiedType === value} onClick={() => onTypeChange(value)}>{label}</button>)}
      </div>
      {orderQueueNotice && (unifiedType === "ALL" || unifiedType === "ORDER")
        ? <p className="im-wb-order-notice" data-tone="warn" role="status" data-action="order-queue-notice">{orderQueueNotice}</p>
        : null}
      <div className="im-wb-rows">
        {rows.length ? rows.map((row) => {
          const active = row.kind === "consultation" ? section === "consultation" && selectedId === row.id : section === "orders" && orderSelection === row.id;
          return <button type="button" key={`${row.kind}:${row.id}`} className="im-wb-row" data-unified-kind={row.kind} data-order-id={row.kind === "order" ? row.id : undefined} data-active={active} aria-current={active ? "page" : undefined}
            onContextMenu={row.kind === "order" ? (event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, orderId: row.id, preference: preferenceOf(row.id, teamIdOf(row.id)), row: event.currentTarget }); } : undefined}
            onClick={() => onSelect(row)}>
            {row.kind === "order"
              ? <OrderGroupAvatar displayNo={row.title} className="im-wb-row-av" />
              : <span className="im-wb-row-av" data-kind={row.kind} aria-hidden="true"><ProfileImage src={row.avatar} fallback={initialOf(row.title)} /></span>}
            <span className="im-wb-row-copy">
              <span className="im-wb-row-top">
                <b>{row.title}</b>
                {row.tag ? <i className="im-wb-tag" data-tone={row.tone}>{row.tag}</i> : null}
                {row.stageCardUnknown ? <i className="im-wb-tag" data-tone="warn">自动卡待核对</i> : null}
                {row.pinned ? <Pin size={11} className="im-wb-row-flag" aria-label="已置顶" /> : null}
              </span>
              <span className="im-wb-row-snip">
                <i className="im-wb-row-state" data-tone={row.stateTone}>{row.state}</i>
                <span className="im-wb-row-preview">{row.snippet}</span>
                {row.meta ? <span className="im-wb-row-meta"><CalendarClock size={10} aria-hidden="true" />{row.meta}</span> : null}
              </span>
            </span>
            <span className="im-wb-row-tail">
              <time dateTime={row.sortAt ? new Date(row.sortAt).toISOString() : undefined}>{row.time}</time>
              {row.muted
                ? <BellOff size={12} className="im-wb-row-flag" aria-label={row.unreadCount > 0 ? "有未读消息，已免打扰" : "已免打扰"} />
                : row.unreadCount > 0
                  ? <i className="im-wb-unread" aria-label={`${row.unreadCount} 条未读`} title={`${row.unreadCount} 条未读`}>{row.unreadCount > 99 ? "99+" : row.unreadCount}</i>
                  : null}
            </span>
          </button>;
        }) : <div className="im-wb-list-empty"><strong>{searchState.loading ? "正在搜索…" : serverSearchActive ? "没有匹配的会话" : "暂无会话"}</strong><span>{serverSearchActive ? "换一个关键词，或清空搜索查看全部已加载会话。" : "新的咨询、投诉和订单群会出现在这里。"}</span></div>}
        {orderNextCursor && !serverSearchActive && (unifiedType === "ALL" || unifiedType === "ORDER")
          ? <button type="button" className="im-wb-more" data-action="load-more-orders" disabled={orderLoadingMore || orderRefreshing}
              onClick={onLoadMore}>{orderRefreshing ? "刷新中…" : orderLoadingMore ? "正在读取…" : "加载更多订单群"}</button>
          : null}
        {hiddenOrderCount ? <button type="button" className="im-wb-more im-og-restore" onClick={onRestoreHidden}>已隐藏 {hiddenOrderCount} 个订单群 · 恢复显示</button> : null}
      </div>
    </aside>
    {menu ? <MessageActionMenu x={menu.x} y={menu.y} label="订单群操作" returnFocus={menu.row}
      items={[
        { id: "pin" as const, label: menu.preference.pinned ? "取消置顶" : "置顶会话" },
        { id: "mute" as const, label: menu.preference.muted ? "取消消息免打扰" : "消息免打扰" },
        { id: "settings" as const, label: "群设置" },
        { id: "hide" as const, label: "不显示会话", danger: true },
      ]}
      onSelect={(action) => { const current = menu; setMenu(null); if (current) onOrderAction(action, current.orderId, current.preference); }} onClose={() => setMenu(null)} /> : null}
  </>;
}