"use client";
import { useState } from "react";
import Link from "next/link";
import { serviceLinks } from "../../lib/service-navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
import { useUserSession } from "@/components/session/user-session-provider";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
// Sheet composition using the same modal primitive as shadcn's Radix Sheet.
const navigationLinks:readonly (readonly [string,string])[] = [["首页", "/"], ["游戏专区", "/#delta-section"], ...serviceLinks.map(s=>[s.title,s.href] as const), ["帮助中心", "/help"]];

function MobileSessionEntry() {
  const session = useUserSession();
  const authOverlay = useAuthOverlay();
  if (session.status === "loading" || session.status === "error") {
    return <Dialog.Close asChild><Link className="button secondary sheet-session" href="/login">账户</Link></Dialog.Close>;
  }
  if (session.status === "guest") {
    return <Dialog.Close asChild><button type="button" className="button primary site-menu-login" onClick={() => authOverlay.open()}>登录 / 注册</button></Dialog.Close>;
  }
  return <div className="sheet-session-account">
    <p className="sheet-session">已登录：{session.displayName ?? "当前用户"}</p>
    <div className="sheet-session-actions">
      <Dialog.Close asChild><Link className="button secondary" href="/account">个人中心</Link></Dialog.Close>
      <button className="button secondary" type="button" onClick={() => { void session.signOut().catch(() => undefined); }}>退出登录</button>
    </div>
  </div>;
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button className="icon-button mobile-menu" aria-label="打开导航菜单"><Menu size={22} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className="nav-sheet site-nav-sheet">
        <div className="sheet-heading"><BrandLogo height={38} /><Dialog.Close className="icon-button" aria-label="关闭菜单"><X size={22} /></Dialog.Close></div>
        <Dialog.Title className="sr-only">移动端菜单</Dialog.Title>
        <Dialog.Description>公开浏览无需登录，交易操作需要登录。</Dialog.Description>
        <MobileSessionEntry />
        <nav aria-label="移动端主导航">
          {navigationLinks.map(([label, href]) =>
            <Dialog.Close key={label} asChild><Link href={href}>{label}</Link></Dialog.Close>)}
        </nav>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
