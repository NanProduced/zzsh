"use client";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, Gift, Headphones, MessageSquare, Share2, X } from "lucide-react";
import { ContactPopover } from "./contact-popover";
import "./service-navigation.css";
export function SupportRail(){return <aside className="support-rail" aria-label="常驻工具">
  <ContactPopover kind="service" side="left" className="rail-item"><Headphones size={21}/><span>联系客服</span></ContactPopover>
  <Link href="/account?view=invite" className="rail-item"><Gift size={21}/><span>邀请码</span></Link>
  <ContactPopover kind="follow" side="left" className="rail-item"><Share2 size={21}/><span>关注我们</span></ContactPopover>
  <Dialog.Root><Dialog.Trigger className="rail-item"><MessageSquare size={21}/><span>投诉建议</span></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="feedback-dialog complaint-panel"><Dialog.Title>投诉建议</Dialog.Title><Dialog.Description>反馈通道暂未开放，请稍后再来查看。</Dialog.Description><Dialog.Close className="icon-button dialog-close" aria-label="关闭投诉建议"><X size={20}/></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
  <button className="rail-item rail-top" onClick={()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})}><ArrowUp size={21}/><span>返回顶部</span></button>
</aside>;}
