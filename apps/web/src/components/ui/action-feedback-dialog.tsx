"use client";
import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
interface ActionFeedbackDialogProps {
  isOpen: boolean; onClose: () => void; title: string; message: string;
}
export function ActionFeedbackDialog({ isOpen, onClose, title, message }: ActionFeedbackDialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className="feedback-dialog"
        onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{message}</Dialog.Description>
        <Dialog.Close className="icon-button dialog-close" aria-label="关闭对话框"><X size={20} /></Dialog.Close>
        <Dialog.Close className="button primary">知道了</Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
