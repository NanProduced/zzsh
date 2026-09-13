"use client";
import { useState } from "react";
import Link from "next/link";
import { serviceLinks } from "../../lib/service-navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
// Sheet composition using the same modal primitive as shadcn's Radix Sheet.
const navigationLinks:readonly (readonly [string,string])[] = [["首页", "/"], ["游戏专区", "/#delta-section"], ...serviceLinks.map(s=>[s.title,s.href] as const), ["帮助中心", "/help"]];
export function MobileNav() {
  const [open, setOpen] = useState(false);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button className="icon-button mobile-menu" aria-label="打开导航菜单"><Menu size={22} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className="nav-sheet site-nav-sheet">
        <div className="sheet-heading"><BrandLogo height={38} /><Dialog.Close className="icon-button" aria-label="关闭菜单"><X size={22} /></Dialog.Close></div>
        <Dialog.Title className="sr-only">移动端菜单</Dialog.Title>
        <Dialog.Description>访客 · 公开浏览无需登录</Dialog.Description>
        <Dialog.Close asChild><Link className="button primary site-menu-login" href="/login">登录 / 注册</Link></Dialog.Close>
        <nav aria-label="移动端主导航">
          {navigationLinks.map(([label, href]) =>
            <Dialog.Close key={label} asChild><Link href={href}>{label}</Link></Dialog.Close>)}
        </nav>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
