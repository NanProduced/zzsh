"use client";
/**
 * 客服工作台「转交 / 结束本轮」弹窗的展示层。
 * 转交目标读取、转交提交与结束本轮的在途锁/结果未知收敛仍由 im-support-view.tsx 编排。
 */
import type { RefObject } from "react";
import { CircleAlert, X } from "lucide-react";
import { ActionTooltip } from "../components/ui/tooltip";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { roundTagOf, typeLabel, type Consultation } from "./im-support-view-model";

export type TransferTarget = { adminUserId: string; displayName: string; inGrace?: boolean; disconnectedSince?: string | null };
export type TransferState = { targets: TransferTarget[]; transferReady: boolean };

export function SupportTransferDialog({ open, onOpenChange, userName, note, onNoteChange, busy, error, state, onConfirm, finalFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName: string;
  note: string;
  onNoteChange: (value: string) => void;
  busy: boolean;
  error?: string;
  state: TransferState | null;
  onConfirm: (targetAdminId: string) => void;
  finalFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="im-wb-dialog" aria-label="转交会话" showCloseButton={false} finalFocus={finalFocusRef}>
      <div className="im-wb-dialog-head"><div><strong>转交会话</strong><span>{userName}</span></div><ActionTooltip content="关闭转交"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => onOpenChange(false)} aria-label="关闭转交"><X size={14} /></button></ActionTooltip></div>
      <label className="im-wb-dialog-note"><span>交接备注（可选，≤200 字）<em>{note.length}/200</em></span>
        <Textarea value={note} maxLength={200} rows={2} aria-label="交接备注（可选）" placeholder="说明交接原因或注意事项" disabled={busy} onChange={(event) => onNoteChange(event.target.value)} /></label>
      {error ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{error}</p>
        : state === null ? <p className="im-wb-dialog-empty">正在读取可转交客服…</p>
        : !state.transferReady ? <p className="im-wb-dialog-empty">会话尚未就绪，暂不可转交</p>
        : !state.targets.length ? <p className="im-wb-dialog-empty">暂无可转交的客服。这里只显示当前在线且可接待的其他客服；投诉会话还会排除无权处理或已被排除的客服。</p>
        : <div className="im-wb-dialog-list">{state.targets.map((target) => <button key={target.adminUserId} type="button" disabled={busy} onClick={() => onConfirm(target.adminUserId)}><span>{target.displayName}</span><small>{target.inGrace ? "连接异常，可能无法及时查看" : "可接待客服"}</small></button>)}</div>}
      <p className="im-wb-dialog-hint">转交后原会话与历史保留；填写的备注会写入交接记录</p>
    </DialogContent>
  </Dialog>;
}

/** 结束本轮：只结束当前轮次，不断开整条线程；确认对象与后果再提交。没有后台恢复/撤销合同，
    所以这里不给「撤销」，也不把结束本轮包装成可逆操作。 */
export function SupportCloseRoundDialog({ open, onOpenChange, target, busy, canOperateSelected, onConfirm, finalFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: Consultation | null;
  busy: boolean;
  canOperateSelected: boolean;
  onConfirm: () => void;
  finalFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="im-wb-dialog" aria-label="结束本轮" showCloseButton={false} finalFocus={finalFocusRef}>
      <div className="im-wb-dialog-head"><div><strong>结束本轮</strong><span>{target ? `${typeLabel(target.type)} · ${roundTagOf(target)}${roundTagOf(target) ? " · " : ""}${target.user?.name || target.user?.username || "平台用户"}` : "当前轮次"}</span></div><ActionTooltip content="关闭结束本轮确认"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => onOpenChange(false)} aria-label="关闭结束本轮确认"><X size={14} /></button></ActionTooltip></div>
      {target ? <dl className="im-wb-confirm">
        <div><dt>{target.type === "COMPLAINT" ? "本轮处理" : "本轮接待"}</dt><dd>{target.assignedAdmin?.name || "尚未分配"}</dd></div>
      </dl> : null}
      <p className="im-wb-dialog-hint">结束后只结束当前这一轮接待：客服状态恢复为空闲，聊天记录保留在同一会话，用户再次咨询会开启新一轮并重新匹配客服。本轮结束不可撤销，平台当前没有恢复本轮接待的入口。</p>
      <div className="im-wb-dialog-actions">
        <button type="button" className="im-wb-btn" onClick={() => onOpenChange(false)}>取消</button>
        <button type="button" className="im-wb-btn im-wb-btn-danger" data-action="confirm-close-consultation" onClick={onConfirm} disabled={busy || !target || !canOperateSelected || !target.canSend}>确认结束本轮</button>
      </div>
    </DialogContent>
  </Dialog>;
}