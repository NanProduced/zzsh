import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { MediaAssetReview } from "../api";
import { mediaContentUrl } from "./supply-review/model";
import { objectName, OWNERSHIP_LABELS, PURPOSE_LABELS, type MediaAction } from "./supply-media/model";

export function MediaNarrowDetailDialog({ selected, confirm, setSelected, detail }: {
  selected: MediaAssetReview | null;
  confirm: { asset: MediaAssetReview; action: MediaAction } | null;
  setSelected: Dispatch<SetStateAction<MediaAssetReview | null>>;
  detail: ReactNode;
}) {
  return (
          <Dialog open={Boolean(selected) && !confirm} onOpenChange={(open) => { if (!open && !confirm) setSelected(null); }}>
            <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col overflow-hidden sm:max-w-2xl" closeLabel="关闭素材详情">
              <DialogHeader className="shrink-0 border-b border-border pb-3">
                <DialogTitle>素材详情</DialogTitle>
                <DialogDescription>审核与公开是两个独立动作；技术与绑定未返回的事实显示未提供。</DialogDescription>
              </DialogHeader>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{detail}</div>
            </DialogContent>
          </Dialog>
  );
}

export function MediaConfirmDialog({ confirm, setConfirm, gameNames, reasonFor, setReasonFor, confirmReasonError, startSimpleWrite }: {
  confirm: { asset: MediaAssetReview; action: MediaAction } | null;
  setConfirm: Dispatch<SetStateAction<{ asset: MediaAssetReview; action: MediaAction } | null>>;
  gameNames: Map<string, string>;
  reasonFor: (asset: MediaAssetReview) => string;
  setReasonFor: (asset: MediaAssetReview, value: string) => void;
  confirmReasonError: string | null;
  startSimpleWrite: (action: MediaAction, asset: MediaAssetReview) => void;
}) {
  return (
      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent className="sm:max-w-md" closeLabel="关闭确认">
          {confirm ? (
            <>
              <DialogHeader>
                <DialogTitle>确认{confirm.action.label}</DialogTitle>
                <DialogDescription>{confirm.action.effect}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <img src={mediaContentUrl(confirm.asset.id)} alt="" className="size-12 rounded border border-border object-contain" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{PURPOSE_LABELS[confirm.asset.purpose] ?? confirm.asset.purpose} · {objectName(confirm.asset, gameNames)}</p>
                    <p className="break-all text-muted-foreground">{confirm.asset.id}</p>
                    <p className="truncate text-muted-foreground">{OWNERSHIP_LABELS[confirm.asset.ownershipKind] ?? confirm.asset.ownershipKind}</p>
                  </div>
                </div>
                {confirm.action.kind !== "cover" ? (
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">{confirm.action.kind === "review" && confirm.action.reasonRequired ? "原因（必填 2–500 字）" : "说明（可选 2–500 字）"}</span>
                    <Textarea value={reasonFor(confirm.asset)} onChange={(event) => setReasonFor(confirm.asset, event.target.value)} maxLength={500} rows={2} placeholder="请填写本次核对说明" />
                  </label>
                ) : null}
                {confirmReasonError ? <p className="text-destructive">{confirmReasonError}</p> : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>取消</Button>
                <Button
                  type="button"
                  variant={confirm.action.kind === "review" && confirm.action.decision === "REJECT" ? "destructive" : "default"}
                  disabled={Boolean(confirmReasonError)}
                  onClick={() => {
                    const target = confirm.asset;
                    const action = confirm.action;
                    setConfirm(null);
                    void startSimpleWrite(action, target);
                  }}
                >
                  {confirm.action.kind === "review" && confirm.action.decision === "QUARANTINE" ? <ShieldAlert /> : null}
                  确认{confirm.action.label}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
  );
}

export function MediaAbandonSheet({ abandonOpen, setAbandonOpen, writeRecord, abandonRecovery }: {
  abandonOpen: boolean;
  setAbandonOpen: Dispatch<SetStateAction<boolean>>;
  writeRecord: { targetLabel: string } | null;
  abandonRecovery: () => void;
}) {
  return (
      <Sheet open={abandonOpen} onOpenChange={setAbandonOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]" closeLabel="关闭放弃恢复">
          <SheetHeader className="shrink-0 border-b border-border">
            <SheetTitle>放弃恢复</SheetTitle>
            <SheetDescription>放弃后不再跟踪该写入的原结果；若服务端实际已处理，重复发起会产生第二次效果。</SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4 py-4">
            <p className="text-xs">对象：{writeRecord?.targetLabel ?? "未知"}</p>
            <p className="text-xs text-muted-foreground">请先在审核队列核对对象当前状态。列表未找到或状态相同都不能证明原命令是否执行。</p>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" size="sm" onClick={abandonRecovery}>我已核对，放弃恢复</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAbandonOpen(false)}>返回</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
  );
}
