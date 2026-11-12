"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  BookOpen,
  Coins,
  Folder,
  Headphones,
  KeyRound,
  ListTree,
  Megaphone,
  ScrollText,
  Shield,
  Store,
  Ticket,
  X,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { flattenHelpNavArticles, type HelpNavData, type HelpNavEntry } from "./nav-data";
import "./help.css";

const categoryIcons: Record<string, LucideIcon> = {
  rental: Ticket,
  publish: Store,
  fees: Coins,
  account: KeyRound,
  "after-sale": Headphones,
  membership: Megaphone,
  agreement: ScrollText,
  book: BookOpen,
  folder: Folder,
  shield: Shield,
};

export function helpFolderIcon(iconKey: string | null, fallback: string) {
  const key = iconKey ?? fallback;
  return Object.hasOwn(categoryIcons, key) ? categoryIcons[key]! : Folder;
}

type NavProps = {
  data: HelpNavData;
  activeSlug?: string;
  /** 点击文章链接后回调（移动端抽屉用于关闭） */
  onNavigate?: () => void;
};

function NavEntry({ entry, activeSlug, onNavigate, nested = false }: Omit<NavProps, "data"> & { entry: HelpNavEntry; nested?: boolean }) {
  if (entry.kind === "ARTICLE") {
    return <li><Link className="help-nav-article-link" href={`/help/${entry.slug}`} aria-current={activeSlug === entry.slug ? "page" : undefined} onClick={onNavigate}>{entry.title}</Link></li>;
  }
  const Icon = nested ? Folder : helpFolderIcon(entry.iconKey, entry.id);
  const articles = flattenHelpNavArticles({ entries: entry.children });
  const expanded = articles.some(article => article.slug === activeSlug);
  return (
    <li>
      <details className="help-nav-category" key={activeSlug} open={expanded}>
        <summary className="help-nav-category-link">
          <Icon size={16} className="help-nav-icon" aria-hidden="true" />
          <span>{entry.title}</span>
          <ChevronRight size={14} className="help-nav-chevron" aria-hidden="true" />
        </summary>
        <ul className="help-nav-articles">
          {entry.children.map(child => <NavEntry key={child.id} entry={child} activeSlug={activeSlug} onNavigate={onNavigate} nested />)}
        </ul>
      </details>
    </li>
  );
}

export function HelpNavTree({ data, activeSlug, onNavigate }: NavProps) {
  return (
    <nav aria-label="帮助目录">
      <ul className="help-nav-list">
        {data.entries.map(entry => <NavEntry key={entry.id} entry={entry} activeSlug={activeSlug} onNavigate={onNavigate} />)}
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
