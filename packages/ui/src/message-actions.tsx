"use client";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

export type MessageActionId = "copy" | "reply" | "revoke" | "delete";
export type MessageActionItem = { id: MessageActionId; label: string; danger?: boolean };
export type MessagePoint = { x: number; y: number };
export type MessageLongPressHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
};

const EDGE = 8;
const LONG_PRESS_DELAY = 550;
const MOVE_TOLERANCE = 10;

/** Mobile long press (default 550ms) at the touch point; any movement or scroll cancels. */
export function useMessageLongPress(onLongPress: (point: MessagePoint, target: EventTarget | null) => void, delay = LONG_PRESS_DELAY): MessageLongPressHandlers {
  const callback = useRef(onLongPress);
  callback.current = onLongPress;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ point: MessagePoint; target: EventTarget | null } | null>(null);
  const cancel = () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    origin.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: event => {
      if (event.pointerType === "mouse") return;
      cancel();
      origin.current = { point: { x: event.clientX, y: event.clientY }, target: event.target };
      timer.current = setTimeout(() => {
        const start = origin.current;
        timer.current = null;
        origin.current = null;
        if (start) callback.current(start.point, start.target);
      }, delay);
    },
    onPointerMove: event => {
      const start = origin.current;
      if (!start) return;
      if (Math.abs(event.clientX - start.point.x) > MOVE_TOLERANCE || Math.abs(event.clientY - start.point.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
  };
}

export type MessageActionMenuProps = {
  x: number;
  y: number;
  items: MessageActionItem[];
  onSelect: (id: MessageActionId) => void;
  onClose: () => void;
  /** The message row to focus after Escape. */
  returnFocus?: HTMLElement | null;
  label?: string;
};

/**
 * Platform-owned message menu. It replaces the browser context menu: positioned
 * at the pointer, clamped inside the viewport, closed by scroll/resize/outside
 * press/Escape, and it owns the revoke confirmation step.
 */
export function MessageActionMenu({ x, y, items, onSelect, onClose, returnFocus, label = "消息操作" }: MessageActionMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const width = rect.width || menu.offsetWidth || 0;
    const height = rect.height || menu.offsetHeight || 0;
    const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
    const left = viewportWidth > 0 ? Math.max(EDGE, Math.min(x, viewportWidth - width - EDGE)) : x;
    const top = viewportHeight > 0 ? Math.max(EDGE, Math.min(y, viewportHeight - height - EDGE)) : y;
    setPosition({ left, top });
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = () => onCloseRef.current();
    const onPointerDown = (event: PointerEvent) => {
      const menu = menuRef.current;
      const target = event.target as Node | null;
      if (menu && target && menu.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const menu = menuRef.current;
      if (!menu) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        const inside = menu.contains(document.activeElement as Node | null);
        close();
        if (inside || document.activeElement === document.body) returnFocusRef.current?.focus();
        return;
      }
      const nodes = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      if (!nodes.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? nodes[0] : event.key === "End" ? nodes[nodes.length - 1] : nodes[(index + (event.key === "ArrowDown" ? 1 : nodes.length - 1)) % nodes.length];
        next?.focus();
        return;
      }
      if (event.key === "Tab") close();
    };
    const onViewportChange = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, []);
  if (!items.length) return null;
  return createPortal(
    <div ref={menuRef} className="message-action-menu" role="menu" aria-label={label}
      style={{ left: position?.left ?? x, top: position?.top ?? y, visibility: position ? "visible" : "hidden" }}>
      {items.map(item => {
        const confirming = item.id === "revoke" && confirmRevoke;
        return <button key={item.id} type="button" role="menuitem" tabIndex={-1} className="message-action-menu-item"
          data-action={item.id} data-danger={item.danger || confirming ? "true" : undefined}
          onClick={() => {
            if (item.id === "revoke" && !confirmRevoke) { setConfirmRevoke(true); return; }
            onSelect(item.id);
          }}>{confirming ? "确认撤回" : item.label}</button>;
      })}
    </div>,
    document.body
  );
}

/** Composer quote bar: the summary is the message's own text or [图片]; never an account id. */
export function MessageReplyQuote({ label, onCancel, disabled = false, cancelLabel = "取消引用" }: { label: string; onCancel: () => void; disabled?: boolean; cancelLabel?: string }) {
  return <div className="message-reply-quote" role="status">
    <span className="message-reply-quote-text" title={label}>回复：{label}</span>
    <button type="button" className="message-reply-quote-cancel" onClick={onCancel} disabled={disabled} aria-label={cancelLabel}>取消</button>
  </div>;
}
