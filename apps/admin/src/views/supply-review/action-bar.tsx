import { useRef } from "react";
import { StatusMessage } from "../../components/ui-elements";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

export type ActionFeedback = { kind: "success" | "error"; message: string };

/** ui/dialog 保护具体对象上的单次处置；打开本身不写入，处理中/结果未知时不可关闭。 */
export function SupplyActionDialog({ title, objectLabel, imageSrc, stale, unknown, onRecheck, consequence, conditions, reason, onReasonChange, onConfirm, onClose, busy, conflict, feedback, onRefresh }: {
  unknown: boolean; onRecheck: () => void;
  imageSrc?: string; stale: boolean;
  conditions?: string[];
  title: string; objectLabel: string; consequence: string; reason: string; onReasonChange: (reason: string) => void;
  onConfirm: () => void; onClose: () => void; busy: boolean; conflict: boolean; feedback?: ActionFeedback; onRefresh: () => void;
}) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const locked = busy || unknown;
  return <Dialog open disablePointerDismissal onOpenChange={open => { if (!open && !locked) closeRef.current(); }}>
    <DialogContent showCloseButton={false} initialFocus={reasonRef} data-supply-action="" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <div className="grid gap-1.5">
        <DialogTitle id="supervision-action-title" className="text-lg">{title}</DialogTitle>
        <p className="break-words text-sm font-medium">{objectLabel}</p>
      </div>
      {imageSrc && <img src={imageSrc} alt={objectLabel} className="max-h-40 w-full rounded-lg object-contain ring-1 ring-foreground/10" />}
      <DialogDescription id="supervision-action-effect" className="leading-relaxed">{consequence}</DialogDescription>
      {conditions && <section aria-label="本次确认仍需独立核对的条件" className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed"><h3 className="font-medium">仍需独立核对的条件</h3><ul className="mt-1 list-disc space-y-1 pl-5">{conditions.map(value => <li key={value}>{value}</li>)}</ul></section>}
      <label className="grid gap-2 text-sm font-medium">
        <span>处置原因<span className="ml-2 text-xs font-normal text-muted-foreground">至少 2 字</span></span>
        <Textarea ref={reasonRef} className="min-h-28 font-normal" maxLength={500} value={reason} disabled={busy || unknown || stale} onChange={event => onReasonChange(event.target.value)} />
        <span className="text-right text-xs font-normal text-muted-foreground">{reason.length} / 500</span>
      </label>
      {feedback && <StatusMessage themeAware error={feedback.kind === "error" ? feedback.message : undefined} success={feedback.kind === "success" ? feedback.message : undefined} />}
      {conflict && <div role="alert" className="grid gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">资料已变化，已保留原因。请刷新后重新核对。<Button variant="outline" className="justify-self-start" onClick={onRefresh} disabled={busy}>刷新详情</Button></div>}
      {stale && <div role="alert" className="grid gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">原账号版本已失效、操作被拒绝或读取失败。原因仍保留，请返回核对当前资料后重新发起操作。<Button variant="outline" className="justify-self-start" onClick={onRecheck} disabled={busy}>返回核对（保留原因）</Button></div>}
      {unknown && <p role="status" className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">结果未知，确认按钮仅重试原操作。确认结果前不能修改原因或另发操作。</p>}
      <DialogFooter>
        <Button variant="outline" size="lg" onClick={onClose} disabled={locked}>取消</Button>
        <Button variant="destructive" size="lg" onClick={onConfirm} disabled={busy || conflict || stale || reason.trim().length < 2} aria-busy={busy || undefined}>{busy ? "处理中…" : "确认" + title.replace(/…$/, "")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
