"use client";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { ServiceShell, type BreadcrumbItem } from "@/components/layout/service-shell";
import { stripHelpSearchQuery } from "./help-url";
import { isBackgroundKeyboardEvent } from "./keyboard-scope";

/** 帮助中心统一外壳：复用 ServiceShell，搜索切换为文档检索 */
export function HelpShell({ children, breadcrumbs, title, description, initialQuery = "" }: {
  children: ReactNode;
  breadcrumbs: readonly BreadcrumbItem[];
  title: string;
  description?: string;
  initialQuery?: string;
}) {
  const router = useRouter();
  // "/" 或 Ctrl/⌘+K 聚焦帮助搜索框；输入控件、弹窗/菜单/浮层、已处理事件与输入法组合不拦截
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isBackgroundKeyboardEvent(event)) return;
      const focusSearch = () => {
        const input = document.querySelector<HTMLElement>('form.site-search input[type="search"]');
        input?.focus({ preventScroll: true });
      };
      if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        focusSearch();
      } else if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  // 外壳的清空按钮只清输入框；在帮助模块内同步清掉已提交查询（q 参数），不动全站账号搜索语义
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest(".site-search-clear") : null;
      if (!target) return;
      const next = stripHelpSearchQuery(window.location.href);
      if (next) router.push(next);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);
  return (
    <ServiceShell
      surface="utility"
      contextLabel={null}
      showBack={false}
      breadcrumbs={breadcrumbs}
      title={title}
      description={description}
      initialQuery={initialQuery}
      onSearch={(value) => {
        const trimmed = value.trim();
        router.push(trimmed ? `/help?q=${encodeURIComponent(trimmed)}` : "/help");
      }}
      searchLabel="搜索帮助文档"
      searchInputLabel="搜索帮助文档"
      searchPlaceholder="搜索帮助文档"
      searchCompactPlaceholder="搜索帮助文档"
    >
      {children}
    </ServiceShell>
  );
}
