"use client";
import { useEffect, useState } from "react";
import { Check, ChevronRight, Info, Link2, ListTree, TriangleAlert } from "lucide-react";

/** 页内目录：滚动同步选中当前章节；桌面右栏与中屏内联两处复用 */
export function HelpToc({ sections, variant }: { sections: readonly { id: string; title: string; depth?: number }[]; variant: "aside" | "inline" }) {
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (sections.length === 0) return;
    const updateActive = () => {
      if (window.scrollY < 120) {
        setCurrent(sections[0]?.id ?? null);
        return;
      }
      let activeId: string | null = sections[0]?.id ?? null;
      for (const section of sections) {
        const el = document.getElementById(section.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= 140) {
          activeId = section.id;
        } else {
          break;
        }
      }
      setCurrent(activeId);
    };

    updateActive();
    window.addEventListener("scroll", updateActive, { passive: true });
    return () => window.removeEventListener("scroll", updateActive);
  }, [sections]);

  const list = (
    <ul className="help-toc-list">
      {sections.map((section) => (
        <li key={section.id} data-depth={section.depth ?? 2}>
          <a href={`#${section.id}`} aria-current={current === section.id ? "true" : undefined}>
            {section.title}
          </a>
        </li>
      ))}
    </ul>
  );

  if (variant === "inline") {
    return (
      <details className="help-toc-inline">
        <summary className="help-toc-inline-summary">
          <ListTree size={15} aria-hidden="true" />
          <span>本文目录</span>
          <ChevronRight size={14} className="help-toc-inline-arrow" aria-hidden="true" />
        </summary>
        <nav aria-label="本文目录">{list}</nav>
      </details>
    );
  }
  return (
    <aside className="help-toc">
      <h2 className="help-toc-heading">本页内容</h2>
      <nav aria-label="本页内容">{list}</nav>
    </aside>
  );
}

/** 恢复旧文章深链，只在当前正文内查找受控新标题，避免将 alias 注入宿主 DOM。 */
export function HelpLegacyAnchors({ aliases }: { aliases: Readonly<Record<string, string>> }) {
  useEffect(() => {
    const apply = () => {
      let hash: string;
      try { hash = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      const targetId = Object.hasOwn(aliases, hash) ? aliases[hash] : null;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (!target?.closest(".help-article")) return;
      target.scrollIntoView({ block: "start", behavior: "instant" });
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [aliases]);
  return null;
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
