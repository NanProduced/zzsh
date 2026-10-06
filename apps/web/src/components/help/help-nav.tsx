"use client";
import { useEffect, useState } from "react";
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
  const expanded = activeCategory === group.id;
  return (
    <li className="help-nav-category">
      <Link
        className="help-nav-category-link"
        href={`/help?category=${group.id}`}
        aria-current={expanded && !activeSlug ? "page" : undefined}
        aria-expanded={group.articles.length > 0 ? expanded : undefined}
        onClick={onNavigate}
      >
        <Icon size={17} className="help-nav-icon" aria-hidden="true" />
        <span>{group.label}</span>
        {group.articles.length > 0 ? <ChevronRight size={14} className="help-nav-chevron" aria-hidden="true" style={expanded ? { transform: "rotate(90deg)" } : undefined} /> : null}
      </Link>
      {expanded && group.articles.length > 0 ? (
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
        {data.categories.map((group) => (
          <NavGroup key={group.id} group={group} activeCategory={activeCategory} activeSlug={activeSlug} onNavigate={onNavigate} />
        ))}
      </ul>
      <hr className="help-nav-divider" />
      <ul className="help-nav-list">
        {data.aux.map((group) => (
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
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      <button type="button" className="help-nav-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <ListTree size={17} aria-hidden="true" />
        <span>帮助目录</span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="help-drawer-overlay" />
          <Dialog.Content className="help-drawer" aria-describedby={undefined}>
            <div className="help-drawer-heading">
              <Dialog.Title asChild><h2>帮助目录</h2></Dialog.Title>
              <Dialog.Close className="help-drawer-close" aria-label="关闭帮助目录"><X size={17} /></Dialog.Close>
            </div>
            <HelpNavTree {...props} onNavigate={() => setOpen(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
