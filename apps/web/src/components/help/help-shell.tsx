"use client";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { ServiceShell, type BreadcrumbItem } from "@/components/layout/service-shell";
import { stripHelpSearchQuery } from "./help-url";

/** 帮助中心统一外壳：复用 ServiceShell，搜索切换为文档检索 */
export function HelpShell({ children, breadcrumbs, title, description, initialQuery = "" }: {
  children: ReactNode;
  breadcrumbs: readonly BreadcrumbItem[];
  title: string;
  description?: string;
  initialQuery?: string;
}) {
  const router = useRouter();
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
