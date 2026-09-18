"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Chip } from "@heroui/react";
import { PortalHeader } from "./portal-header";
import { PortalFooter } from "./portal-footer";
export type ServiceSurface = "browse" | "detail" | "editor" | "account" | "utility";
export type BreadcrumbItem = { label: string; href?: string };

const surfaceMeta: Record<ServiceSurface, { label: string; hint: string; color: "accent" | "success" | "warning" | "default" }> = {
  browse: { label: "公开浏览", hint: "公开浏览无需登录", color: "success" },
  detail: { label: "账号详情", hint: "费用与条件在此核对", color: "success" },
  editor: { label: "号主服务", hint: "草稿可跳转分组编辑", color: "accent" },
  account: { label: "个人中心", hint: "仅展示当前身份数据", color: "accent" },
  utility: { label: "平台服务", hint: "按当前页面继续操作", color: "default" },
};

type ServiceShellProps = {
  children: ReactNode;
  title: string;
  description: string;
  initialQuery?: string;
  onSearch?: (query: string) => void;
  backHref?: string;
  backLabel?: string;
  surface?: ServiceSurface;
  contextLabel?: string | null;
  breadcrumbs?: readonly BreadcrumbItem[];
  searchLabel?: string;
  searchInputLabel?: string;
  searchPlaceholder?: string;
  searchCompactPlaceholder?: string;
};

export function ServiceShell({
  children,
  title,
  description,
  initialQuery = "",
  onSearch,
  backHref = "/",
  backLabel = "返回首页",
  surface = "utility",
  contextLabel,
  breadcrumbs,
  searchLabel = "搜索公开账号",
  searchInputLabel = "搜索账号编号或名称",
  searchPlaceholder = "搜索账号编号或名称",
  searchCompactPlaceholder = searchPlaceholder,
}: ServiceShellProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const meta = surfaceMeta[surface];
  const trail = breadcrumbs?.length ? breadcrumbs : [{ label: "首页", href: "/" }, { label: title }];
  const context = contextLabel === undefined ? meta.label : contextLabel;
  return <div className={`portal-home portal-subpage functional-shell functional-shell--${surface}`}>
    <PortalHeader home={false} query={query} onQueryChange={setQuery} onSearch={onSearch ?? ((value: string) => router.push(`/accounts?q=${encodeURIComponent(value)}`))} searchLabel={searchLabel} searchInputLabel={searchInputLabel} searchPlaceholder={searchPlaceholder} searchCompactPlaceholder={searchCompactPlaceholder} />
    <main id="main-content" className="portal-width subpage-main functional-main">
      <Breadcrumbs items={trail} />
      <header className="functional-page-heading">
        <div className="functional-heading-copy">
          {surface !== "browse" && <Link className="functional-back" href={backHref}><ArrowLeft size={16} aria-hidden="true" /><span>{backLabel}</span></Link>}
          <div className="functional-title-block"><h1>{title}</h1><p>{description}</p></div>
        </div>
        {context ? <div className="functional-context" aria-label="页面上下文">
          <Chip className="functional-context-chip" color={meta.color} variant="soft">{context}</Chip>
          <span>{meta.hint}</span>
        </div> : null}
      </header>
      {children}
    </main>
    <PortalFooter />
  </div>;
}

function Breadcrumbs({ items }: { items: readonly BreadcrumbItem[] }) {
  const mobileItems = items.length > 3 ? [{ label: "…" }, items[items.length - 1]!] : items;
  return <nav className="functional-breadcrumb" aria-label="面包屑">
    <BreadcrumbList className="functional-breadcrumb-list functional-breadcrumb-list--desktop" items={items} />
    <BreadcrumbList className="functional-breadcrumb-list functional-breadcrumb-list--mobile" items={mobileItems} />
  </nav>;
}

function BreadcrumbList({ className, items }: { className: string; items: readonly BreadcrumbItem[] }) {
  return <ol className={className}>
    {items.map((item, index) => {
      const current = index === items.length - 1;
      return <li key={item.label + "-" + index} aria-current={current ? "page" : undefined}>
        {index > 0 ? <span className="functional-breadcrumb-separator" aria-hidden="true">›</span> : null}
        {item.href && !current ? <Link href={item.href}>{item.label}</Link> : <span>{item.label}</span>}
      </li>;
    })}
  </ol>;
}
