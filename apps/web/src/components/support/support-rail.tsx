"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { useUserSession } from "@/components/session/user-session-provider";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, Gift, Headphones, MessageSquare, Share2, X } from "lucide-react";
import { ContactPopover } from "./contact-popover";
import { CustomerSupportWorkspace } from "./customer-support-workspace";
import { supportUnreadAriaLabel, supportUnreadBadge, supportUnreadDescription } from "./support-unread";
import { useSupportUnread } from "./use-support-unread";
import type { SupportType } from "@/lib/support-intent";
import type { SupportOrderContext } from "./support-dialog-request";
import "./service-navigation.css";
export function SupportRail(){
  const auth = useAuthOverlay();
  const [supportOpen,setSupportOpen]=useState(false);
  const [requestedType,setRequestedType]=useState<SupportType>("SERVICE");
  const [orderContext,setOrderContext]=useState<SupportOrderContext>();
  const [preview,setPreview]=useState(false);
  const [orderParty,setOrderParty]=useState<"renter"|"owner"|undefined>();
  const [requestSerial,setRequestSerial]=useState(0);
  const [toolsOpen,setToolsOpen]=useState(false);
  const [orderId,setOrderId]=useState<string>();
  const [hasOpened,setHasOpened]=useState(false);
  useEffect(()=>{const open=(event:Event)=>{const {party,orderId:id}=(event as CustomEvent).detail??{};if((party!=="renter"&&party!=="owner")||typeof id!=="string"||!id)return;lastSupportTriggerRef.current=document.activeElement instanceof HTMLButtonElement?document.activeElement:null;auth.open(window.location.pathname+window.location.search,()=>{setOrderParty(party);setOrderId(id);setRequestSerial(n=>n+1);setHasOpened(true);setSupportOpen(true);});};window.addEventListener("zzsh:order-groups",open);return()=>window.removeEventListener("zzsh:order-groups",open);},[auth]);
  const lastSupportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const requestSupport = (type: SupportType, trigger?: HTMLButtonElement | null, context?:SupportOrderContext) => {
    lastSupportTriggerRef.current = trigger ?? null;
    auth.open(window.location.pathname + window.location.search, () => {
      setRequestedType(type);
      setOrderContext(context);
      setOrderParty(undefined);
      setOrderId(undefined);
      setHasOpened(true);
      setRequestSerial(n => n + 1);
      setSupportOpen(true);
    });
  };
  const setSupportVisibility = (open: boolean) => {
    setSupportOpen(open);
    if(!open)setOrderContext(undefined);
    if (!open) requestAnimationFrame(() => lastSupportTriggerRef.current?.focus());
  };
  // 常驻监听必须走当次渲染的触发链。auth.open 里的会话状态是当次渲染的快照；沿用首帧那份
  // 会把意图挂在“等会话确认”上，而会话往往在用户点击前就已确认完、状态不再变化，于是那个
  // 挂起的意图永远没人接手，窗口开不出来。ref 每次渲染都更新，监听因此始终拿到最新链。
  const requestSupportRef = useRef(requestSupport);
  requestSupportRef.current = requestSupport;
  useEffect(()=>{
    // 页面内的客服/投诉入口（帮助中心、403 页）复用同一条触发链：先过登录门，再开窗，
    // 关闭时焦点回到原触发钮。事件名与 support-dialog-request.ts 的 SUPPORT_OPEN_EVENT 一致。
    // 投诉保留入口意图，服务端仍统一到SERVICE线程。
    // 不自动开窗——客服只有一个容器，就是本 rail 的弹窗，没有独立 /support 路由。
    // 这些入口自己带 data-support-trigger，onPointerDownOutside 的既有豁免才会放过它们，
    // 否则真实的按下-抬起-点击序列会被当成“点了弹窗外面”而立刻把窗口关掉。
    const open=(event:Event)=>{const detail=(event as CustomEvent).detail??{};const trigger=(detail.trigger instanceof HTMLButtonElement?detail.trigger:null)??(document.activeElement instanceof HTMLButtonElement?document.activeElement:null);requestSupportRef.current(detail.type==="COMPLAINT"?"COMPLAINT":"SERVICE",trigger,detail.orderContext);};
    window.addEventListener("zzsh:open-support",open);
    return()=>window.removeEventListener("zzsh:open-support",open);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{ setPreview(process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).get("preview") === "1"); },[]);
  // 入口未读：窗口关着时由这里低频轮询，窗口开着时由窗口自己的 5 秒目录轮询把同一份快照发布上来，
  // 一条链路两个写入方，不做两套轮询。未登录不请求；演示模式不打扰。角标挂在常驻入口上，
  // 用户不点开窗口也能看到客服回复和订单群消息。投诉建议复用同一个窗口，所以角标只挂一处，不重复计数。
  const session = useUserSession();
  const unreadIdentity = session.status === "authenticated" && session.userId ? `${session.userId}:${session.identityVersion}` : null;
  const unread = useSupportUnread(unreadIdentity, Boolean(unreadIdentity) && !supportOpen && !preview,session.status==="authenticated"?session.userId:null);
  const unreadBadge = supportUnreadBadge(unread);
  const supportEntryLabel = supportUnreadAriaLabel("联系客服", unread);
  // The window is non-modal, so Radix leaves focus on the entry button and Tab would walk
  // the whole page before reaching the composer. Start the tab order inside the window.
  useEffect(()=>{ if(supportOpen) document.querySelector<HTMLElement>(".support-dialog-content")?.focus(); },[supportOpen]);
  return <aside
    className="support-rail"
    aria-label="常驻工具"
    data-expanded={toolsOpen ? "true" : "false"}
    data-unread={unreadBadge ? "true" : "false"}
    onKeyDown={(event) => { if (event.key === "Escape" && toolsOpen) setToolsOpen(false); }}
    onClick={(event) => { if (toolsOpen && (event.target as HTMLElement).closest(".rail-item")) setToolsOpen(false); }}
  >
    {/* 触屏 FAB 收起时只剩耳机图标，用户不知道点开是客服。常驻一行“客服”小字把入口说清楚；
        文字放在圆钮里，不扩大占位、不压 safe-area，展开后换成“收起”继续说明当前动作。
        新消息用 aria-describedby 说明，按钮本名仍然是“展开/收起常用工具”。 */}
    <button type="button" className="rail-fab" aria-expanded={toolsOpen} aria-label={toolsOpen ? "收起常用工具" : "展开常用工具"} aria-describedby={unreadBadge ? "support-rail-unread-text" : undefined} data-unread={unreadBadge ? "true" : "false"} onClick={() => setToolsOpen((open) => !open)}>{toolsOpen ? <X size={22} aria-hidden="true" /> : <Headphones size={22} aria-hidden="true" />}<span className="rail-fab-label" aria-hidden="true">{toolsOpen ? "收起" : "客服"}</span>{unreadBadge ? <b className="rail-unread" data-kind={unreadBadge.counted ? "count" : "dot"} aria-hidden="true">{unreadBadge.text}</b> : null}</button>
    {unreadBadge ? <span id="support-rail-unread-text" className="sr-only" role="status">{supportUnreadDescription(unread)}</span> : null}
    <Dialog.Root open={supportOpen} modal={false} onOpenChange={setSupportVisibility}>
      <button type="button" className="rail-item" aria-haspopup="dialog" aria-label={supportEntryLabel} data-support-trigger data-unread={unreadBadge ? "true" : "false"} onClick={(event)=>requestSupport("SERVICE",event.currentTarget)}><Headphones size={21} className="pointer-events-none"/><span>联系客服</span>{unreadBadge ? <b className="rail-unread" data-kind={unreadBadge.counted ? "count" : "dot"} aria-hidden="true">{unreadBadge.text}</b> : null}</button>
      <Dialog.Portal forceMount><Dialog.Overlay className="modal-overlay support-dialog-overlay"/><Dialog.Content forceMount tabIndex={-1} className="support-dialog-content" aria-describedby="support-dialog-description" onEscapeKeyDown={event=>{if(event.target instanceof HTMLElement&&event.target.closest(".order-team-image-viewer, .message-lightbox, .yarl__portal"))event.preventDefault();}} onPointerDownOutside={(event)=>{const target = event.detail.originalEvent.target; if(target instanceof Element && target.closest("[data-support-trigger], [data-auth-dialog], .message-lightbox, .yarl__portal")) event.preventDefault();}}><Dialog.Title className="sr-only">站内客服</Dialog.Title><Dialog.Description id="support-dialog-description" className="sr-only">选择客服类型并开始站内咨询。</Dialog.Description>{hasOpened ? <CustomerSupportWorkspace embedded visible={supportOpen} preview={preview} initialType={requestedType} initialOrderContext={orderContext} initialOrderParty={orderParty} initialOrderId={orderId} requestSerial={requestSerial} onClose={()=>setSupportVisibility(false)} /> : null}</Dialog.Content></Dialog.Portal>
      <button type="button" className="rail-item" aria-haspopup="dialog" data-support-trigger onClick={(event)=>requestSupport("COMPLAINT",event.currentTarget)}><MessageSquare size={21} className="pointer-events-none"/><span>投诉建议</span></button>
    </Dialog.Root>
    <Link href="/account?view=invite" className="rail-item"><Gift size={21}/><span>邀请码</span></Link>
    <ContactPopover kind="follow" side="left" className="rail-item"><Share2 size={21}/><span>关注我们</span></ContactPopover>
    <button className="rail-item rail-top" onClick={()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})}><ArrowUp size={21}/><span>返回顶部</span></button>
  </aside>;
}
