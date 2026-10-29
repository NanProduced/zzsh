"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Coins,
  Headphones,
  KeyRound,
  ListTree,
  Megaphone,
  ScrollText,
  Store,
  Ticket,
  X,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import type { AnyHelpCategoryId } from "@/content/help/types";
import type { HelpNavCategory, HelpNavData } from "./nav-data";
import "./help.css";

const categoryIcons: Record<string, LucideIcon> = {
  rental: Ticket,
  publish: Store,
  fees: Coins,
  account: KeyRound,
  "after-sale": Headphones,
  membership: Megaphone,
  agreement: ScrollText,
};

type NavProps = {
  data: HelpNavData;
  activeCategory?: AnyHelpCategoryId;
  activeSlug?: string;
  /** 点击文章链接后回调（移动端抽屉用于关闭） */
  onNavigate?: () => void;
};

function NavGroup({ group, activeCategory, activeSlug, onNavigate }: { group: HelpNavCategory; activeCategory?: AnyHelpCategoryId; activeSlug?: string; onNavigate?: () => void }) {
  const Icon = categoryIcons[group.id] ?? ListTree;
  const isCurrentCategory = activeCategory === group.id;
  // 文章列表仅在具体文章页展开；分类页仅展示分类层级，避免与正文文章列表重复
  const shouldExpandArticles = Boolean(activeSlug) && isCurrentCategory;
  const targetHref = group.articles[0] ? `/help/${group.articles[0].slug}` : `/help?category=${group.id}`;
  return (
    <li className="help-nav-category">
      <Link
        className="help-nav-category-link"
        href={targetHref}
        aria-current={isCurrentCategory && !activeSlug ? "page" : undefined}
        aria-expanded={group.articles.length > 0 ? shouldExpandArticles : undefined}
        onClick={onNavigate}
      >
        <Icon size={17} className="help-nav-icon" aria-hidden="true" />
        <span>{group.label}</span>
        {group.articles.length > 0 ? (
          <ChevronRight
            size={14}
            className="help-nav-chevron"
            aria-hidden="true"
            style={shouldExpandArticles ? { transform: "rotate(90deg)" } : undefined}
          />
        ) : null}
      </Link>
      {shouldExpandArticles && group.articles.length > 0 ? (
        <ul className="help-nav-articles">
          {group.articles.map((article) => (
            <li key={article.slug}>
              <Link
                className="help-nav-article-link"
                href={`/help/${article.slug}`}
                aria-current={activeSlug === article.slug ? "page" : undefined}
                onClick={onNavigate}
              >
                {article.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function HelpNavTree({ data, activeCategory, activeSlug, onNavigate }: NavProps) {
  return (
    <nav aria-label="帮助目录">
      <ul className="help-nav-list">
        {data.categories.filter(group => group.articles.length > 0).map((group) => (
          <NavGroup key={group.id} group={group} activeCategory={activeCategory} activeSlug={activeSlug} onNavigate={onNavigate} />
        ))}
      </ul>
      {data.aux.some(group => group.articles.length > 0) ? <hr className="help-nav-divider" /> : null}
      <ul className="help-nav-list">
        {data.aux.filter(group => group.articles.length > 0).map((group) => (
          <NavGroup key={group.id} group={group} activeCategory={activeCategory} activeSlug={activeSlug} onNavigate={onNavigate} />
        ))}
      </ul>
    </nav>
  );
}

export function HelpNavAside(props: NavProps) {
  return (
    <div className="help-nav">
      <h2 className="help-nav-heading">帮助目录</h2>
      <HelpNavTree {...props} />
    </div>
  );
}

export function HelpNavDrawer(props: NavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const scrollPosRef = useRef(0);
  const navigatingRef = useRef(false);

  useEffect(() => { navigatingRef.current = true; setOpen(false); }, [pathname]);

  const handleOpen = () => {
    navigatingRef.current = false;
    scrollPosRef.current = window.scrollY;
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="help-nav-trigger"
        onClick={handleOpen}
        aria-haspopup="dialog"
      >
        <ListTree size={17} aria-hidden="true" />
        <span>帮助目录</span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="help-drawer-overlay" />
          <Dialog.Content
            className="help-drawer"
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (navigatingRef.current) return;
              triggerRef.current?.focus({ preventScroll: true });
              window.scrollTo({ top: scrollPosRef.current, behavior: "instant" });
            }}
          >
            <div className="help-drawer-heading">
              <Dialog.Title asChild><h2>帮助目录</h2></Dialog.Title>
              <Dialog.Close className="help-drawer-close" aria-label="关闭帮助目录" onClick={handleClose}>
                <X size={17} />
              </Dialog.Close>
            </div>
            <HelpNavTree {...props} onNavigate={() => { navigatingRef.current = true; handleClose(); }} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
