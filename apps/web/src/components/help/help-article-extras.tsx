"use client";
import { useEffect, useState } from "react";
import { Check, Info, Link2, TriangleAlert } from "lucide-react";

/** 页内目录：滚动同步选中当前章节；桌面右栏与中屏内联两处复用 */
export function HelpToc({ sections, variant }: { sections: readonly { id: string; title: string }[]; variant: "aside" | "inline" }) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const targets = sections
      .map((section) => document.getElementById(section.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(entry.target.id);
        }
      },
      { rootMargin: "-96px 0px -65% 0px", threshold: 0 },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [sections]);

  const list = (
    <ol>
      {sections.map((section, index) => (
        <li key={section.id}>
          <a href={`#${section.id}`} aria-current={current === section.id ? "true" : undefined}>
            {index + 1}. {section.title}
          </a>
        </li>
      ))}
    </ol>
  );

  if (variant === "inline") {
    return (
      <details className="help-toc-inline">
        <summary>本页目录</summary>
        <nav aria-label="本页目录">{list}</nav>
      </details>
    );
  }
  return (
    <div className="help-toc">
      <h2 className="help-toc-heading">本页内容</h2>
      <nav aria-label="本页目录">{list}</nav>
      <HelpCopyLink />
    </div>
  );
}

/** 复制当前文章/章节链接；失败给出可恢复反馈 */
export function HelpCopyLink({ label = "复制链接" }: { label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2400);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="help-toc-copy"
      data-state={state === "idle" ? undefined : state}
      onClick={async () => {
        const text = window.location.href;
        const legacyCopy = () => {
          const area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          try {
            return document.execCommand("copy");
          } catch {
            return false;
          } finally {
            area.remove();
          }
        };
        try {
          await Promise.race([
            navigator.clipboard.writeText(text),
            new Promise((_, reject) => setTimeout(reject, 1500)),
          ]);
          setState("done");
        } catch {
          setState(legacyCopy() ? "done" : "error");
        }
      }}
    >
      {state === "done" ? <Check size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}
      <span>{state === "done" ? "已复制" : state === "error" ? "复制失败，请手动复制地址栏链接" : label}</span>
    </button>
  );
}

export function HelpCalloutIcon({ tone }: { tone: "info" | "warning" }) {
  return tone === "warning" ? <TriangleAlert size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />;
}

/** 旧 /help#锚点 兼容：客户端读取 hash 后精确跳转到对应文章 */
export function LegacyHashHandler({ map }: { map: Record<string, string> }) {
  useEffect(() => {
    const apply = () => {
      const slug = map[window.location.hash.replace(/^#/, "")];
      if (slug) window.location.replace(`/help/${slug}`);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [map]);
  return null;
}
