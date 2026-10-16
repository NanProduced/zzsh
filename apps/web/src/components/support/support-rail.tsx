"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, Gift, Headphones, MessageSquare, Share2, X } from "lucide-react";
import { ContactPopover } from "./contact-popover";
import { CustomerSupportWorkspace } from "./customer-support-workspace";
import type { SupportType } from "@/lib/support-intent";
import "./service-navigation.css";
export function SupportRail(){
  const pathname = usePathname();
  const auth = useAuthOverlay();
  const [supportOpen,setSupportOpen]=useState(false);
  const [requestedType,setRequestedType]=useState<SupportType>("SERVICE");
  const [preview,setPreview]=useState(false);
  const [orderParty,setOrderParty]=useState<"renter"|"owner"|undefined>();
  const [requestSerial,setRequestSerial]=useState(0);
  const [toolsOpen,setToolsOpen]=useState(false);
  const [orderId,setOrderId]=useState<string>();
  const [hasOpened,setHasOpened]=useState(false);
  useEffect(()=>{const open=(event:Event)=>{const {party,orderId:id}=(event as CustomEvent).detail??{};if((party!=="renter"&&party!=="owner")||typeof id!=="string"||!id)return;lastSupportTriggerRef.current=document.activeElement instanceof HTMLButtonElement?document.activeElement:null;auth.open(window.location.pathname+window.location.search,()=>{setOrderParty(party);setOrderId(id);setRequestSerial(n=>n+1);setHasOpened(true);setSupportOpen(true);});};window.addEventListener("zzsh:order-groups",open);return()=>window.removeEventListener("zzsh:order-groups",open);},[auth]);
  const lastSupportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const requestSupport = (type: SupportType, trigger?: HTMLButtonElement | null) => {
    lastSupportTriggerRef.current = trigger ?? null;
    auth.open(window.location.pathname + window.location.search, () => {
      setRequestedType(type);
      setOrderParty(undefined);
      setOrderId(undefined);
      setHasOpened(true);
      setRequestSerial(n => n + 1);
      setSupportOpen(true);
    });
  };
  const setSupportVisibility = (open: boolean) => {
    setSupportOpen(open);
    if (!open) requestAnimationFrame(() => lastSupportTriggerRef.current?.focus());
  };
  useEffect(()=>{
    // 页面内的客服/投诉入口（如 /support）复用同一条触发链：先过登录门，再开窗，
    // 关闭时焦点回到原触发钮。不自动开窗——落地页自己提供可阅读的入口。
    const open=(event:Event)=>{const detail=(event as CustomEvent).detail??{};const type=detail.type==="COMPLAINT"?"COMPLAINT":"SERVICE";const trigger=document.activeElement instanceof HTMLButtonElement?document.activeElement:null;requestSupport(type,trigger);};
    window.addEventListener("zzsh:open-support",open);
    return()=>window.removeEventListener("zzsh:open-support",open);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{ setPreview(new URLSearchParams(window.location.search).get("preview") === "1"); },[]);
  // The window is non-modal, so Radix leaves focus on the entry button and Tab would walk
  // the whole page before reaching the composer. Start the tab order inside the window.
  useEffect(()=>{ if(supportOpen) document.querySelector<HTMLElement>(".support-dialog-content")?.focus(); },[supportOpen]);
  return <aside
    className="support-rail"
    aria-label="常驻工具"
    data-expanded={toolsOpen ? "true" : "false"}
    onKeyDown={(event) => { if (event.key === "Escape" && toolsOpen) setToolsOpen(false); }}
    onClick={(event) => { if (toolsOpen && (event.target as HTMLElement).closest(".rail-item")) setToolsOpen(false); }}
  >
    <button type="button" className="rail-fab" aria-expanded={toolsOpen} aria-label={toolsOpen ? "收起常用工具" : "展开常用工具"} onClick={() => setToolsOpen((open) => !open)}>{toolsOpen ? <X size={22} aria-hidden="true" /> : <Headphones size={22} aria-hidden="true" />}</button>
    <Dialog.Root open={supportOpen} modal={false} onOpenChange={setSupportVisibility}>
      <button type="button" className="rail-item" aria-haspopup="dialog" data-support-trigger onClick={(event)=>requestSupport("SERVICE",event.currentTarget)}><Headphones size={21} className="pointer-events-none"/><span>联系客服</span></button>
      <Dialog.Portal forceMount><Dialog.Overlay className="modal-overlay support-dialog-overlay"/><Dialog.Content forceMount className="support-dialog-content" aria-describedby="support-dialog-description" onEscapeKeyDown={event=>{if(event.target instanceof HTMLElement&&event.target.closest(".order-team-image-viewer"))event.preventDefault();}} onPointerDownOutside={(event)=>{const target = event.detail.originalEvent.target; if(target instanceof Element && target.closest("[data-support-trigger], [data-auth-dialog]")) event.preventDefault();}}><Dialog.Title className="sr-only">站内客服</Dialog.Title><Dialog.Description id="support-dialog-description" className="sr-only">选择客服类型并开始站内咨询。</Dialog.Description>{hasOpened ? <CustomerSupportWorkspace embedded visible={supportOpen} preview={preview} initialType={requestedType} initialOrderParty={orderParty} initialOrderId={orderId} requestSerial={requestSerial} onClose={()=>setSupportVisibility(false)} /> : null}</Dialog.Content></Dialog.Portal>
      <button type="button" className="rail-item" aria-haspopup="dialog" data-support-trigger onClick={(event)=>requestSupport("COMPLAINT",event.currentTarget)}><MessageSquare size={21} className="pointer-events-none"/><span>投诉建议</span></button>
    </Dialog.Root>
    <Link href="/account?view=invite" className="rail-item"><Gift size={21}/><span>邀请码</span></Link>
    <ContactPopover kind="follow" side="left" className="rail-item"><Share2 size={21}/><span>关注我们</span></ContactPopover>
    <button className="rail-item rail-top" onClick={()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})}><ArrowUp size={21}/><span>返回顶部</span></button>
  </aside>;
}
