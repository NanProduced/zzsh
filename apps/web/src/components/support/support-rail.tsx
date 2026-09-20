"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, Gift, Headphones, MessageSquare, Share2 } from "lucide-react";
import { ContactPopover } from "./contact-popover";
import { CustomerSupportWorkspace } from "./customer-support-workspace";
import type { SupportType } from "@/lib/support-intent";
import "./service-navigation.css";
export function SupportRail(){
  const pathname = usePathname();
  const [supportOpen,setSupportOpen]=useState(false);
  const [requestedType,setRequestedType]=useState<SupportType>("SERVICE");
  const [preview,setPreview]=useState(false);
  const [orderParty,setOrderParty]=useState<"renter"|"owner"|undefined>();
  const [requestSerial,setRequestSerial]=useState(0);
  useEffect(()=>{const open=(event:Event)=>{const party=(event as CustomEvent).detail?.party;if(party!=="renter"&&party!=="owner")return;lastSupportTriggerRef.current=document.activeElement instanceof HTMLButtonElement?document.activeElement:null;setOrderParty(party);setRequestSerial(n=>n+1);setSupportOpen(true);};window.addEventListener("zzsh:order-groups",open);return()=>window.removeEventListener("zzsh:order-groups",open);},[]);
  const lastSupportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const setSupportVisibility = (open: boolean) => {
    setSupportOpen(open);
    if (!open) requestAnimationFrame(() => lastSupportTriggerRef.current?.focus());
  };
  useEffect(()=>{
    if(pathname === "/support") setSupportOpen(true);
    setPreview(new URLSearchParams(window.location.search).get("preview") === "1");
  },[pathname]);
  return <aside className="support-rail" aria-label="常驻工具">
    <Dialog.Root open={supportOpen} modal={false} onOpenChange={setSupportVisibility}>
      <button type="button" className="rail-item" aria-haspopup="dialog" data-support-trigger onClick={(event)=>{lastSupportTriggerRef.current=event.currentTarget;setRequestedType("SERVICE");setOrderParty(undefined);setRequestSerial(n=>n+1);setSupportOpen(true);}}><Headphones size={21}/><span>联系客服</span></button>
      <Dialog.Portal forceMount><Dialog.Overlay className="modal-overlay support-dialog-overlay"/><Dialog.Content forceMount className="support-dialog-content" aria-describedby="support-dialog-description" onEscapeKeyDown={event=>{if(event.target instanceof HTMLElement&&event.target.closest(".order-team-image-viewer"))event.preventDefault();}} onPointerDownOutside={(event)=>{if(event.detail.originalEvent.target instanceof HTMLElement && event.detail.originalEvent.target.closest("[data-support-trigger], [data-auth-dialog]")) event.preventDefault();}}><Dialog.Title className="sr-only">站内客服</Dialog.Title><Dialog.Description id="support-dialog-description" className="sr-only">选择客服类型并开始站内咨询。</Dialog.Description><CustomerSupportWorkspace embedded preview={preview} initialType={requestedType} initialOrderParty={orderParty} requestSerial={requestSerial} onClose={()=>setSupportVisibility(false)} /></Dialog.Content></Dialog.Portal>
      <button type="button" className="rail-item" aria-haspopup="dialog" data-support-trigger onClick={(event)=>{lastSupportTriggerRef.current=event.currentTarget;setRequestedType("COMPLAINT");setOrderParty(undefined);setRequestSerial(n=>n+1);setSupportOpen(true);}}><MessageSquare size={21}/><span>投诉建议</span></button>
    </Dialog.Root>
    <Link href="/account?view=invite" className="rail-item"><Gift size={21}/><span>邀请码</span></Link>
    <ContactPopover kind="follow" side="left" className="rail-item"><Share2 size={21}/><span>关注我们</span></ContactPopover>
    <button className="rail-item rail-top" onClick={()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})}><ArrowUp size={21}/><span>返回顶部</span></button>
  </aside>;
}
