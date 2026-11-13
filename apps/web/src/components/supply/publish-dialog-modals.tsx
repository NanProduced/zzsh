"use client";

import type { Dispatch, SetStateAction } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Check, X } from "lucide-react";
import { AgreementBody } from "./publish-dialogs";
import type { FullPayoutTerms, PublishingOptions } from "../../lib/supply-types";

export interface TermsDialogProps {
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
  agreement: PublishingOptions["agreement"] | null | undefined;
  formDisabled: boolean;
  readable: boolean;
  onReady: (digest: string) => void;
  onAccept: () => void;
}

export function TermsDialog({
  open,
  onOpenChange,
  agreement,
  formDisabled,
  readable,
  onReady,
  onAccept,
}: TermsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-agreement-backdrop" />
        <Dialog.Popup className="publish-dialog publish-agreement-dialog" data-slot="dialog-content">
          <header>
            <Dialog.Title>{agreement?.title ?? "出租条款"}</Dialog.Title>
            <Dialog.Close className="publish-reading-close" aria-label="关闭出租条款">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">
            当前读取的协议正文；阅读不会自动同意条款，上架前仍需单独勾选确认。
          </Dialog.Description>
          {agreement ? <AgreementBody body={agreement.body} bodyDocument={agreement.bodyDocument} target={agreement.digest} onReady={onReady} /> : <p>暂未取得协议正文。</p>}
          <div className="publish-agreement-dialog-actions">
            <Dialog.Close className="button secondary">返回</Dialog.Close>
            {agreement ? (
              <button
                type="button"
                className="button primary"
                disabled={formDisabled || !readable}
                onClick={onAccept}
              >
                我已阅读并同意本条款
              </button>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface PayoutTermsDialogProps {
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
  currentPayoutTerms: FullPayoutTerms | null;
  formDisabled: boolean;
  readable: boolean;
  onReady: (digest: string) => void;
  onAccept: () => void;
}

export function PayoutTermsDialog({
  open,
  onOpenChange,
  currentPayoutTerms,
  formDisabled,
  readable,
  onReady,
  onAccept,
}: PayoutTermsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-agreement-backdrop" />
        <Dialog.Popup className="publish-dialog publish-agreement-dialog" data-slot="dialog-content">
          <header>
            <Dialog.Title>{currentPayoutTerms?.title ?? "全额包赔条款"}</Dialog.Title>
            <Dialog.Close className="publish-reading-close" aria-label="关闭包赔条款">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">
            当前读取的全额包赔协议正文；阅读不会自动同意条款，上架前仍需单独勾选确认。
          </Dialog.Description>
          {currentPayoutTerms ? <AgreementBody body={currentPayoutTerms.body} bodyDocument={currentPayoutTerms.bodyDocument} target={currentPayoutTerms.termsDigest} onReady={onReady} /> : <p>暂未取得协议正文。</p>}
          <div className="publish-agreement-dialog-actions">
            <Dialog.Close className="button secondary">返回</Dialog.Close>
            {currentPayoutTerms ? (
              <button
                type="button"
                className="button primary"
                disabled={formDisabled || !readable}
                onClick={onAccept}
              >
                我已阅读并同意包赔条款
              </button>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface PreviewMediaDialogProps {
  previewMedia: { url: string; title: string } | null;
  onClose: () => void;
}

export function PreviewMediaDialog({
  previewMedia,
  onClose,
}: PreviewMediaDialogProps) {
  return (
    <Dialog.Root open={previewMedia !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-media-lightbox-backdrop" />
        <Dialog.Popup className="publish-dialog publish-media-lightbox" data-slot="dialog-content" aria-label={previewMedia?.title ?? "图片预览"}>
          <header className="publish-media-lightbox-head">
            <Dialog.Title>{previewMedia?.title ?? "图片预览"}</Dialog.Title>
            <Dialog.Close className="publish-reading-close" aria-label="关闭图片预览">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
          </header>
          {previewMedia ? (
            <div className="publish-media-lightbox-body">
              <img src={previewMedia.url} alt={previewMedia.title} />
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface PublishSuccessDialogProps {
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
  successCountdown: number;
  onNavigateToAccounts: () => void;
}

export function PublishSuccessDialog({
  open,
  onOpenChange,
  successCountdown,
  onNavigateToAccounts,
}: PublishSuccessDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-success-backdrop" />
        <Dialog.Popup className="publish-dialog publish-success-dialog" data-slot="dialog-content">
          <div className="publish-success-fireworks" aria-hidden="true">
            <span className="firework-particle particle-1">🎆</span>
            <span className="firework-particle particle-2">✨</span>
            <span className="firework-particle particle-3">🎉</span>
            <span className="firework-particle particle-4">✨</span>
            <span className="firework-particle particle-5">🥳</span>
            <span className="firework-particle particle-6">🎆</span>
          </div>
          <div className="publish-success-icon-badge">
            <Check size={32} aria-hidden="true" />
          </div>
          <header className="publish-success-header">
            <Dialog.Title>账号已成功上架！</Dialog.Title>
            <Dialog.Description>
              你的账号已发布至平台，租客可在游戏专区浏览并下单。
            </Dialog.Description>
          </header>
          <div className="publish-success-timer">
            <strong>{successCountdown}</strong> 秒后将自动前往我的账号…
          </div>
          <div className="publish-success-actions">
            <button
              type="button"
              className="button primary"
              onClick={onNavigateToAccounts}
            >
              立即前往我的账号
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => onOpenChange(false)}
            >
              留在本页
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
