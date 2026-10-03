import { useEffect, useRef } from "react";

import { lightboxKeyAction } from "./model";

/**
 * 页内图片放大:原生 <dialog> 模态——Tab/Shift+Tab 焦点约束、背景不可操作、
 * 单次 Escape 关闭、关闭后焦点回到触发按钮。仅放大已授权的同一 content 地址,不新增下载能力。
 */
export function Lightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // happy-dom 等环境未完整实现 showModal 时退化为 open 属性,焦点约束由下方 Tab 处理保证。
        dialog.setAttribute("open", "");
      }
    }
    closeRef.current?.focus();

    const close = () => onClose();
    const onCancel = (event: Event) => {
      event.preventDefault();
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (lightboxKeyAction(event.key) === "close") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Tab") {
        const focusables = [
          ...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("keydown", onKeyDown);
      if (dialog.open) dialog.close();
      previous?.focus?.({preventScroll:true});
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={alt}
      className="max-h-[92vh] max-w-[94vw] border-0 bg-transparent p-0 backdrop:bg-black/80"
    >
      <div className="relative grid place-items-center">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="absolute -top-2 right-0 z-10 translate-y-[-100%] rounded-md border border-border bg-surface-raised px-3 py-1.5 text-xs text-foreground hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          关闭 Esc
        </button>
        <img src={src} alt={alt} className="max-h-[82vh] max-w-[90vw] rounded-lg bg-surface-raised object-contain" />
        <p className="mt-3 max-w-[80vw] text-center text-xs text-muted-foreground">
          {caption ?? "放大核对只读取已授权图片,不新增下载能力。"}
        </p>
      </div>
    </dialog>
  );
}
