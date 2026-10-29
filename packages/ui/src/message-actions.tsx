"use client";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MessageActionId = "copy" | "reply" | "revoke" | "delete" | "jump";
export type MessageActionItem = { id: MessageActionId; label: string; danger?: boolean; icon?: ReactNode };
function menuIcon(id: MessageActionId): ReactNode {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (id === "copy") return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>;
  if (id === "reply") return <svg {...common}><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v2"/></svg>;
  if (id === "revoke") return <svg {...common}><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>;
  if (id === "delete") return <svg {...common}><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>;
  return <svg {...common}><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>;
}
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
          }}><span className="message-action-icon">{item.icon ?? menuIcon(item.id)}</span>{confirming ? "确认撤回" : item.label}</button>;
      })}
    </div>,
    document.body
  );
}

/** Composer quote bar: the summary is the message's own text or [图片]; never an account id. */
/** Portable text emoji for chat composers; Unicode keeps every client/history readable. */
export const CHAT_EMOJIS = [
  { emoji: "😀", label: "开心" }, { emoji: "😄", label: "大笑" }, { emoji: "😂", label: "笑哭" },
  { emoji: "🙂", label: "微笑" }, { emoji: "😉", label: "眨眼" }, { emoji: "😊", label: "害羞" },
  { emoji: "😍", label: "喜欢" }, { emoji: "🤔", label: "思考" }, { emoji: "😅", label: "尴尬" },
  { emoji: "😭", label: "大哭" }, { emoji: "😡", label: "生气" }, { emoji: "😴", label: "困了" },
  { emoji: "👍", label: "赞" }, { emoji: "👎", label: "踩" }, { emoji: "🙏", label: "感谢" },
  { emoji: "👌", label: "好的" }, { emoji: "💪", label: "加油" }, { emoji: "🎉", label: "庆祝" },
  { emoji: "❤️", label: "爱心" }, { emoji: "🔥", label: "火热" }, { emoji: "✅", label: "完成" },
  { emoji: "❌", label: "不行" }, { emoji: "⭐", label: "星标" }, { emoji: "🎮", label: "游戏" },
] as const;

/** A compact quote below a sent message; right-click opens the jump action. */
export function MessageQuoted({ text, senderName, onJump }: { text: string; senderName?: string | null; onJump?: () => void }) {
  const [menu, setMenu] = useState<MessagePoint | null>(null);
  const quoteRef = useRef<HTMLSpanElement | null>(null);
  const jump = () => { setMenu(null); onJump?.(); };
  return <>
    <span ref={quoteRef} className="message-quoted" data-jump={onJump ? "true" : undefined} title={onJump ? "右键定位原文" : text}
      onClick={() => { if (onJump) jump(); }}
      onContextMenu={(event) => { if (!onJump) return; event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}>
      {senderName ? <span className="message-quoted-sender">{senderName}：</span> : null}
      <span className="message-quoted-text">{text}</span>
    </span>
    {menu ? <MessageActionMenu x={menu.x} y={menu.y} label="引用操作" items={[{ id: "jump", label: "定位到原文位置" }]} onSelect={jump} onClose={() => setMenu(null)} returnFocus={quoteRef.current} /> : null}
  </>;
}

export function MessageReplyQuote({ label, onCancel, disabled = false, cancelLabel = "取消引用" }: { label: string; onCancel: () => void; disabled?: boolean; cancelLabel?: string }) {
  return <div className="message-reply-quote" role="status">
    <span className="message-reply-quote-text" title={label}>回复：{label}</span>
    <button type="button" className="message-reply-quote-cancel" onClick={onCancel} disabled={disabled} aria-label={cancelLabel}>取消</button>
  </div>;
}
