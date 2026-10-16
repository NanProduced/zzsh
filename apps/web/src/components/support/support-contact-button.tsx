"use client";
import type { ReactNode } from "react";
import type { SupportType } from "@/lib/support-intent";
import { requestSupportDialog } from "./support-dialog-request";

/**
 * 页面内的客服/投诉入口。客服只有一个容器——右侧常驻工具列的弹窗；没有独立 /support 路由，
 * 所以这里发窗口事件交给 SupportRail：先过登录门再开窗，关闭后焦点回到本钮。
 *
 * 必须是 client component：帮助中心文章页和 403 页是 server component，不能直接挂 onClick。
 * 帮助中心（client）与 403 页（client）也用同一个组件，四个入口只有一种写法。
 */
export function SupportContactButton({
  type = "SERVICE",
  className,
  children,
}: {
  type?: SupportType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button type="button" data-support-trigger className={className} onClick={() => requestSupportDialog(type)}>
      {children}
    </button>
  );
}
