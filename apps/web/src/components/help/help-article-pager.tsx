"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { HelpNavArticle } from "./nav-data";
import { isBackgroundKeyboardEvent } from "./keyboard-scope";

/** 文章底部上一篇/下一篇：链接按帮助目录顺序，键盘 ←/→ 切换，跳转后焦点回正文标题 */
export function HelpArticlePager({ prev, next }: { prev: HelpNavArticle | null; next: HelpNavArticle | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const initialRender = useRef(true);

  useEffect(() => {
    // 首次挂载不干预：保留浏览器对 #章节 深链的默认定位
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    if (window.location?.hash) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    heading.focus({ preventScroll: true });
  }, [pathname]);

  useEffect(() => {
    if (!prev && !next) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !isBackgroundKeyboardEvent(event)) return;
      if (event.key === "ArrowLeft" && prev) {
        event.preventDefault();
        router.push(`/help/${prev.slug}`);
      } else if (event.key === "ArrowRight" && next) {
        event.preventDefault();
        router.push(`/help/${next.slug}`);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [prev, next, router]);

  if (!prev && !next) return null;
  return (
    <nav className="help-pager" aria-label="上一篇 / 下一篇">
      {prev && (
        <Link className="help-pager-link help-pager-link--prev" href={`/help/${prev.slug}`} rel="prev">
          <ArrowLeft size={16} aria-hidden="true" />
          <span>
            <span className="help-pager-dir">上一篇</span>
            <span className="help-pager-title">{prev.title}</span>
          </span>
        </Link>
      )}
      {next && (
        <Link className="help-pager-link help-pager-link--next" href={`/help/${next.slug}`} rel="next">
          <span>
            <span className="help-pager-dir">下一篇</span>
            <span className="help-pager-title">{next.title}</span>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      )}
    </nav>
  );
}
