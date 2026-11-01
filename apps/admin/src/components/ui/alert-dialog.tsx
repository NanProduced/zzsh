"use client";

import { useRef, type ReactNode } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { cn } from "@/lib/utils";
import { workspacePortalContainer } from "@/lib/workspace-portal";
import { Button } from "@/components/ui/button";

/**
 * 危险操作确认（Base UI AlertDialog，与 apps/web 的 AlertDialog 同基座）。
 * 真正的 alertdialog 语义：模态、禁止点外关闭、默认焦点在取消动作；
 * busy 期间忽略关闭且确认不可重复点击。调用方在结果确定后才关闭，组件不替调用方判定成功。
 */
export function ConfirmAlertDialog({
  open, onOpenChange, title, description, children, cancelLabel = "取消", confirmLabel, onConfirm,
  busy = false, confirmDisabled = false, className, contentLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  cancelLabel?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
  className?: string;
  contentLabel: string;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const requestClose = (next: boolean) => {
    if (!next && busy) return;
    onOpenChange(next);
  };
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={requestClose}>
      <AlertDialogPrimitive.Portal container={workspacePortalContainer()}>
        <AlertDialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs" />
        <AlertDialogPrimitive.Popup
          aria-label={contentLabel}
          aria-busy={busy || undefined}
          data-slot="alert-dialog-content"
          initialFocus={cancelRef}
          className={cn(
            "im-wb-dialog fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none",
            className,
          )}
        >
          <AlertDialogPrimitive.Title className="m-0 text-sm font-semibold">{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="m-0 text-xs leading-relaxed text-muted-foreground">
            {description}
          </AlertDialogPrimitive.Description>
          {children}
          <div className="im-wb-dialog-actions">
            <Button ref={cancelRef} type="button" variant="ghost" size="sm" disabled={busy} onClick={() => requestClose(false)}>
              {cancelLabel}
            </Button>
            <Button type="button" variant="destructive" size="sm" disabled={busy || confirmDisabled} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
