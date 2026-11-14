"use client";

import { type Dispatch, type SetStateAction } from "react";
import { CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { ProfileImage } from "@zzsh/ui/profile-image";
import { ActionTooltip } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { formatListTime, initialOf } from "./im-support-format";
import { auditStateLabel, auditTypeLabel, type AuditConversation, type AuditTimeFilter } from "./im-support-management-model";
import { safeIdentityName } from "./im-support-management-identity";

const TYPE_OPTIONS: [string, string][] = [["ALL", "全部类型"], ["SERVICE", "咨询"], ["COMPLAINT", "投诉"], ["ORDER", "订单群"]];
const STATE_OPTIONS: [string, string][] = [["ALL", "全部状态"], ["WAITING", "待接入"], ["ACTIVE", "处理中"], ["CLOSED", "已结束"]];
const TIME_OPTIONS: [string, string][] = [["all", "全部时间"], ["today", "今天"], ["7d", "近 7 天"]];

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <Select value={value} items={options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel }))} onValueChange={(next) => onChange(String(next ?? ""))}>
    <SelectTrigger size="sm" className="im-wb-mgmt-filter" aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(([optionValue, optionLabel]) => <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>)}</SelectContent>
  </Select>;
}

export function PatrolSessionList({
  items, visibleItems, listState, listError, listMoreError, loadingMore, nextCursor,
  type, adminId, stateFilter, timeFilter, adminOptions, selectedId,
  setStateFilter, setTimeFilter, changeType, changeAdmin, refreshList, loadMore, setSelectedId,
}: {
  items: AuditConversation[];
  visibleItems: AuditConversation[];
  listState: "loading" | "ready" | "forbidden" | "error";
  listError: string;
  listMoreError: string;
  loadingMore: boolean;
  nextCursor: string | null;
  type: string;
  adminId: string;
  stateFilter: string;
  timeFilter: AuditTimeFilter;
  adminOptions: [string, string][];
  selectedId: string | null;
  setStateFilter: Dispatch<SetStateAction<string>>;
  setTimeFilter: Dispatch<SetStateAction<AuditTimeFilter>>;
  changeType: (next: string) => void;
  changeAdmin: (next: string) => void;
  refreshList: () => void;
  loadMore: () => Promise<void>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
}) {
  return <aside className="im-wb-mgmt-patrol-list" aria-label="巡视会话列表">
      <div className="im-wb-queue-head">
        <strong>会话巡视</strong>
        <b>已加载 {items.length} 条{visibleItems.length !== items.length ? `（当前筛选显示 ${visibleItems.length} 条）` : ""}</b>
        <Button variant="ghost" size="icon-sm" className="im-wb-mgmt-refresh" aria-label="刷新巡视列表" onClick={refreshList}><RefreshCw /></Button>
      </div>
      <div className="im-wb-mgmt-filters">
        <FilterSelect label="按类型筛选" value={type} options={TYPE_OPTIONS} onChange={changeType} />
        <FilterSelect label="按客服筛选" value={adminId} options={adminOptions} onChange={changeAdmin} />
        <FilterSelect label="按状态筛选" value={stateFilter} options={STATE_OPTIONS} onChange={setStateFilter} />
        <FilterSelect label="按时间筛选" value={timeFilter} options={TIME_OPTIONS} onChange={(next) => setTimeFilter(next === "today" || next === "7d" ? next : "all")} />
      </div>
      <p className="im-wb-filter-note">左侧按用户会话聚合，第 N 轮为最近轮次；状态和时间仅筛选已加载会话。</p>
      <div className="im-wb-rows">
        {listState === "loading" && !items.length ? <div className="im-wb-list-empty"><strong>正在读取会话…</strong></div> : null}
        {listState === "forbidden" ? <div className="im-wb-list-empty"><ShieldCheck size={20} aria-hidden="true" /><strong>无权查看会话巡视</strong><span>{listError || "需要「客服管理读取」权限。"}</span></div> : null}
        {listState === "error" ? <div className="im-wb-list-empty"><CircleAlert size={20} aria-hidden="true" /><strong>会话列表读取失败</strong><span>{listError}</span><Button variant="outline" size="sm" onClick={refreshList}>重新读取</Button></div> : null}
        {visibleItems.map((item) => {
          const name = safeIdentityName(item.title) ?? "会话成员";

          return <button type="button" key={item.id} className="im-wb-row" data-active={selectedId === item.id} aria-current={selectedId === item.id ? "page" : undefined}
          onClick={() => setSelectedId(item.id)}>
          <span className="im-wb-row-av" aria-hidden="true"><ProfileImage src={item.userAvatar} fallback={initialOf(name)} /></span>
          <span className="im-wb-row-copy">
            <span className="im-wb-row-top">
              <b>{name}</b>
              <i className="im-wb-tag" data-tone={item.type === "COMPLAINT" ? "warn" : "neutral"}>{auditTypeLabel(item.type)}</i>
              {item.type !== "ORDER" && item.roundSeq ? <i className="im-wb-tag" data-tone="neutral">第 {item.roundSeq} 轮</i> : null}
              <time>{item.lastMessageAt ? formatListTime(item.lastMessageAt) : "—"}</time>
            </span>
            <span className="im-wb-row-snip">
              {item.type === "ORDER" ? `订单 ${item.displayNo ?? "编号未提供"}${item.gameName ? ` · ${item.gameName}` : ""}` : `${safeIdentityName(item.userName) ?? "会话成员"} · 客服 ${item.adminName}`}
            </span>
            <span className="im-wb-row-foot">
              <em data-state={auditStateLabel(item.state)}>{auditStateLabel(item.state)}</em>
              {item.adminUnreadCount ? <ActionTooltip content="接待方未读"><span className="im-wb-unread-pill">接待未读 {item.adminUnreadCount}</span></ActionTooltip> : null}
              {item.state === "WAITING" && item.firstUserMessageAt ? (
                <span className="im-wb-waiting-time text-xs text-muted-foreground">
                  等待中 · 留言于 {formatListTime(item.firstUserMessageAt)}
                </span>
              ) : null}
              {item.addRound && item.addRound > 0 ? (
                <span className="im-wb-tag text-xs" data-tone="warn">已补派第 {item.addRound} 轮</span>
              ) : null}
              {item.remindDueAt ? (
                <span className="text-xs text-muted-foreground">提醒截止 {formatListTime(item.remindDueAt)}</span>
              ) : null}
            </span>
          </span>
        </button>;
        })}
        {listState === "ready" && !items.length ? <div className="im-wb-list-empty"><strong>暂无可巡视会话</strong><span>当前筛选条件下未查询到会话。</span></div> : null}
        {listState === "ready" && items.length > 0 && !visibleItems.length ? <div className="im-wb-list-empty"><strong>当前筛选没有匹配会话</strong><span>调整客服、状态或时间筛选。</span></div> : null}
      </div>
      {listMoreError ? <div className="im-wb-notice" data-tone="warn" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{listMoreError}</span><button type="button" disabled={loadingMore} onClick={() => void loadMore()}>重试</button></div> : null}
      {nextCursor && !listMoreError ? <button type="button" className="im-wb-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "更多会话"}</button> : null}
    </aside>;
}
