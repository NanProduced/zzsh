import { useEffect, useRef } from "react";
import { Button, StatusMessage } from "../../components/ui-elements";

export type ActionFeedback = { kind: "success" | "error"; message: string };

/** 原生模态保护具体对象上的单次处置；打开本身不写入。 */
export function SupplyActionDialog({ title, objectLabel, imageSrc, stale, unknown, onRecheck, consequence, conditions, reason, onReasonChange, onConfirm, onClose, busy, conflict, feedback, onRefresh }: {
  unknown: boolean; onRecheck: () => void;
  imageSrc?: string; stale: boolean;
  conditions?: string[];
  title: string; objectLabel: string; consequence: string; reason: string; onReasonChange: (reason: string) => void;
  onConfirm: () => void; onClose: () => void; busy: boolean; conflict: boolean; feedback?: ActionFeedback; onRefresh: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus({preventScroll:true}); };
  }, []);
  return <dialog ref={dialogRef} aria-labelledby="supervision-action-title" aria-describedby="supervision-action-effect" className="supervision-dialog wf-dialog" onKeyDown={event => {if(event.key!=="Tab")return;const elements=[...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]),textarea:not([disabled])")],first=elements[0],last=elements.at(-1);if(event.shiftKey && document.activeElement===first || !event.shiftKey && document.activeElement===last){event.preventDefault();(event.shiftKey?last:first)?.focus();}}} onCancel={event => { event.preventDefault(); if (!busy && !unknown) closeRef.current(); }}>
    <h2 id="supervision-action-title" className="text-lg font-semibold">{title}</h2>
    <p className="mt-3 break-words text-sm font-medium">{objectLabel}</p>
    {imageSrc && <img src={imageSrc} alt={objectLabel} className="mt-4 max-h-40 w-full object-contain" />}
    <p id="supervision-action-effect" className="mt-3 text-sm leading-relaxed text-muted-foreground">{consequence}</p>
    {conditions && <section aria-label="本次确认仍需独立核对的条件" className="mt-3 text-sm leading-relaxed"><h3 className="font-medium">仍需独立核对的条件</h3><ul className="mt-1 list-disc space-y-1 pl-5">{conditions.map(value => <li key={value}>{value}</li>)}</ul></section>}
    <label className="mt-6 block text-sm">处置原因<span className="ml-2 text-xs text-muted-foreground">至少 2 字</span><textarea autoFocus className="mt-2 min-h-28 w-full rounded-md border border-border bg-background p-3" maxLength={500} value={reason} disabled={busy || unknown || stale} onChange={event => onReasonChange(event.target.value)} /></label>
    <p className="mt-1 text-right text-xs text-muted-foreground">{reason.length} / 500</p>
    {feedback && <StatusMessage error={feedback.kind === "error" ? feedback.message : undefined} success={feedback.kind === "success" ? feedback.message : undefined} />}
    {conflict && <div role="alert" className="mt-3 text-sm text-warning">资料已变化，已保留原因。请刷新后重新核对。<Button variant="secondary" onClick={onRefresh} disabled={busy}>刷新详情</Button></div>}
    {stale && <div role="alert" className="mt-3 text-sm text-warning">原账号版本已失效、操作被拒绝或读取失败。原因仍保留，请返回核对当前资料后重新发起操作。<Button variant="secondary" onClick={onRecheck} disabled={busy}>返回核对（保留原因）</Button></div>}
    {unknown && <p role="status" className="mt-3 text-sm text-warning">结果未知，确认按钮仅重试原操作。确认结果前不能修改原因或另发操作。</p>}
    <footer className="mt-6 flex justify-end gap-3"><Button variant="secondary" onClick={onClose} disabled={busy || unknown}>取消</Button><Button variant="danger" onClick={onConfirm} disabled={busy || conflict || stale || reason.trim().length < 2} loading={busy}>确认{title.replace(/…$/, "")}</Button></footer>
  </dialog>;
}
