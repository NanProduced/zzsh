"use client";

import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { ArrowDown, CircleAlert, Headphones, ShieldCheck } from "lucide-react";
import { ProfileImage } from "@zzsh/ui/profile-image";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { ConversationMap, type ConversationMapEntry } from "../components/assistant-ui/elements/conversation-map";
import type { OrderTeamAccess } from "@zzsh/ui/order-team-panel";
import type { ImSystemNoticeScope } from "@zzsh/im-client/message-state";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { SupportInfoHint } from "./im-support-report-range";
import { initialOf } from "./im-support-format";
import { auditStateLabel, auditTypeLabel, type AuditConversation, type AuditMessage } from "./im-support-management-model";
import type { SupportManagementRequest } from "./im-support-management";
import { AuditTimeline } from "./im-support-management-timeline";

export function PatrolReadonlyChat({
  selected, selectedName, roundCount, roundStatus, roundError, roundJumpHint, supplementError, setRoundReloadToken,
  messageState, messageCursor, earlierError, readingEarlier, loadEarlier, messageError, setMessageReloadToken,
  messages, orderInfo, patrolScope, request, onOpenProfile, historyConversationId,
  roundsCurrent, mapEntries, selectedRoundId, mapVisibleIds, selectRound, viewportRef, syncSelectedRoundFromScroll,
}: {
  selected: AuditConversation | null;
  selectedName: string | null;
  roundCount: number | undefined;
  roundStatus: "idle" | "loading" | "ready" | "error";
  roundError: string;
  roundJumpHint: string;
  supplementError: string;
  setRoundReloadToken: Dispatch<SetStateAction<number>>;
  messageState: "idle" | "loading" | "ready" | "forbidden" | "error";
  messageCursor: string | null;
  earlierError: string;
  readingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  messageError: string;
  setMessageReloadToken: Dispatch<SetStateAction<number>>;
  messages: AuditMessage[];
  orderInfo: OrderTeamAccess | null;
  patrolScope: ImSystemNoticeScope;
  request: SupportManagementRequest;
  onOpenProfile?: (userId: string) => void;
  historyConversationId: string | null;
  roundsCurrent: boolean;
  mapEntries: ConversationMapEntry[];
  selectedRoundId: string | null;
  mapVisibleIds: string[];
  selectRound: (roundId: string) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
  syncSelectedRoundFromScroll: () => void;
}) {
  return <section className="im-wb-chat im-wb-mgmt-chat" aria-label="只读会话">
      {!selected ? <div className="im-wb-mgmt-chat-empty"><Headphones size={22} aria-hidden="true" /><strong>选择一条会话巡视</strong><span>打开即只读查看，不填写原因，也不发送消息。</span></div> : <>
        <header className="im-wb-chat-head">
          <span className="im-wb-chat-av" aria-hidden="true"><ProfileImage src={selected.userAvatar} fallback={initialOf(selectedName ?? "会话成员")} /></span>
          <div className="im-wb-chat-title">
            <h2>{selectedName}</h2>
            <span>{auditTypeLabel(selected.type)} · {auditStateLabel(selected.state)} · 最近接待：{selected.adminName} · {selected.type === "ORDER" ? "整条订单群历史" : `整条线程历史${roundCount ? `（共 ${roundCount} 轮）` : ""}`}</span>
          </div>
          <div className="im-wb-chat-actions">
            <Badge variant="outline">只读巡视</Badge>
            <SupportInfoHint label="巡视操作说明">参与订单群请使用成员邀请；交接会话请在客服工作台转交。</SupportInfoHint>
          </div>
        </header>
        {selected.type !== "ORDER" && (roundStatus === "loading" || roundStatus === "error" || roundJumpHint || supplementError) ? <div className="im-wb-patrol-round-status">
          {roundStatus === "loading" ? <span className="im-wb-patrol-round-note">正在读取轮次…</span> : null}
          {roundStatus === "error" ? <span className="im-wb-patrol-round-note" data-tone="warn" title={roundError}>轮次读取失败<button type="button" onClick={() => setRoundReloadToken((token) => token + 1)}>重试</button></span> : null}
          {roundJumpHint ? <span className="im-wb-patrol-round-note" role="status">{roundJumpHint}</span> : null}
          {supplementError ? <span className="im-wb-patrol-round-note" data-tone="warn" role="status">{supplementError}</span> : null}
        </div> : null}
        {messageState === "ready" && (messageCursor || earlierError) ? <div className="im-wb-patrol-history">
          {earlierError ? <span className="im-wb-history-error" role="alert">{earlierError}</span> : null}
          <button type="button" disabled={readingEarlier} onClick={() => void loadEarlier()}>{readingEarlier ? "正在读取更早消息…" : earlierError ? "重新读取更早消息" : "更早的消息"}</button>
        </div> : null}
        {/* Static history: no live follow; the load control stays out of the prepend list. */}
        <MessageScrollerPrimitive.Provider defaultScrollPosition="last-anchor">
          <div className="im-wb-patrol-stream">
            {selected.type !== "ORDER" && roundsCurrent && mapEntries.length ? <ConversationMap
              entries={mapEntries}
              activeId={selectedRoundId ?? undefined}
              visibleIds={mapVisibleIds}
              onSelect={selectRound}
              side="right"
              className="im-wb-patrol-map h-full shrink-0 justify-between py-2 max-sm:hidden text-popover-foreground"
            /> : null}
            <div className="im-wb-stream-wrap">
            <MessageScrollerPrimitive.Root className="im-wb-scroller">
            <MessageScrollerPrimitive.Viewport ref={viewportRef} onScroll={syncSelectedRoundFromScroll} preserveScrollOnPrepend={false} className="im-wb-viewport im-wb-mgmt-viewport" aria-label="只读会话消息">
              <MessageScrollerPrimitive.Content className="im-wb-content im-wb-patrol-content">
                {messageState === "loading" ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
                  : messageState === "forbidden" ? <div className="im-wb-empty"><ShieldCheck size={22} aria-hidden="true" /><strong>无权查看该会话消息</strong><span>{messageError}</span></div>
                    : <>
                      {messageState === "error" ? <div className="im-wb-empty"><CircleAlert size={22} aria-hidden="true" /><strong>消息读取失败</strong><span>{messageError}</span><Button variant="outline" size="sm" onClick={() => setMessageReloadToken(token => token + 1)}>重新读取</Button></div> : null}
                      {messages.length ? <AuditTimeline messages={messages} orderInfo={orderInfo} scope={patrolScope} request={request} onOpenProfile={onOpenProfile} /> : messageState !== "error" ? <div className="im-wb-empty"><Headphones size={22} aria-hidden="true" /><strong>
                        {selected.historyState === "NOT_ESTABLISHED" ? "会话通道尚未建立"
                          : selected.historyState === "LEGACY_UNAVAILABLE" ? "历史会话暂不可读"
                            : selected.historyState === "RECOVERING" ? "会话通道恢复中，请稍后刷新"
                              : !selected.historyState && selected.type !== "ORDER" ? "历史状态尚未提供，暂不读取"
                                : selected.historyState && selected.historyState !== "AVAILABLE" ? "历史状态暂不支持读取，请刷新核对"
                                  : messageCursor ? "当前页没有可显示消息，可继续读取更早记录"
                                    : historyConversationId ? "该会话暂无可读消息" : "会话消息尚未就绪"}
                      </strong></div> : null}
                    </>}
              </MessageScrollerPrimitive.Content>
            </MessageScrollerPrimitive.Viewport>
            <Tooltip>
              <TooltipTrigger render={<MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>} />
              <TooltipContent>跳到最新消息</TooltipContent>
            </Tooltip>
          </MessageScrollerPrimitive.Root></div>
          </div>
        </MessageScrollerPrimitive.Provider>
      </>}
    </section>;
}
