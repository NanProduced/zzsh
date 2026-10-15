import { useEffect, useRef, useState } from "react";

import { Button, StatusMessage } from "../../components/ui-elements";
import { Icons } from "../../components/icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { formatDate } from "../../api";
import {
  actionLabel,
  asCommandError,
  describeOperation,
  describeReadError,
  isUnresolvedRecord,
  validateOperationResult,
  type OperationReadResult,
  type PendingRecord,
  type SecurityCommandError,
} from "./model";

export type ResolvedRefresh = { refresh: "skipped" | "ok" | "failed" };

export function OperationResultDialog({
  open,
  commandId,
  record,
  currentSessionId,
  read,
  onClose,
  onResolved,
  refreshCurrent,
  onDismissRecord,
  onRegenerateBackupCodes,
}: {
  open: boolean;
  commandId: string | undefined;
  record: PendingRecord | undefined;
  currentSessionId: string;
  read: (input: { commandId: string }) => Promise<OperationReadResult>;
  onClose: () => void;
  onResolved: (result: OperationReadResult) => Promise<ResolvedRefresh>;
  refreshCurrent: () => Promise<boolean>;
  onDismissRecord: (commandId: string) => void;
  onRegenerateBackupCodes: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [result, setResult] = useState<OperationReadResult>();
  const [error, setError] = useState<SecurityCommandError>();
  const [invalidMessage, setInvalidMessage] = useState<string>();
  const [refresh, setRefresh] = useState<"idle" | "loading" | "ok" | "failed">("idle");
  const [attempt, setAttempt] = useState(0);
  const recordRef = useRef(record);
  recordRef.current = record;

  useEffect(() => {
    if (!open) {
      setPhase("loading");
      setResult(undefined);
      setError(undefined);
      setInvalidMessage(undefined);
      setRefresh("idle");
      return;
    }
    if (!commandId || !recordRef.current) {
      setPhase("error");
      setError({ status: 400, code: "INVALID_ARGUMENT" });
      return;
    }
    let cancelled = false;
    setPhase("loading");
    setError(undefined);
    setInvalidMessage(undefined);
    setRefresh("idle");
    read({ commandId })
      .then(async (next) => {
        if (cancelled) return;
        const activeRecord = recordRef.current;
        if (!activeRecord) return;
        const validation = validateOperationResult(next, activeRecord);
        if (!validation.ok) {
          setInvalidMessage(validation.message);
          setPhase("error");
          return;
        }
        setResult(next);
        setPhase("ready");
        setRefresh("loading");
        const outcome = await onResolved(next).catch(() => ({ refresh: "failed" as const }));
        if (cancelled) return;
        setRefresh(outcome.refresh === "skipped" ? "idle" : outcome.refresh);
      })
      .catch((failure) => {
        if (cancelled) return;
        setError(asCommandError(failure));
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
    // 只按打开/命令/重试触发；结算会更新 record 对象，不能作为依赖以免重复读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, commandId, attempt]);

  const presentation = result ? describeOperation(result, { currentSessionId }) : undefined;
  const showsRefresh = result?.status === "completed" && (result.action === "password.change" || result.action === "pin.set" || result.action === "pin.change");
  const dismissable = record && isUnresolvedRecord(record);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>核对原结果</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            只读查询原命令的非敏感回执；不会重放命令、不会修改任何状态。
          </DialogDescription>
        </DialogHeader>
        {record ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            本机记录：{actionLabel(record.action)} · 首次提交于 {formatDate(record.createdAt)}
            {record.targetKind === "session" && record.targetSessionId && record.targetSessionId !== currentSessionId
              ? " · 原作用对象为更早的会话"
              : ""}
            。
          </p>
        ) : null}
        {phase === "loading" ? <p className="text-xs text-muted-foreground">正在核对…</p> : null}
        {phase === "error" ? (
          <div className="space-y-3">
            {invalidMessage ? (
              <StatusMessage error={`读取失败：${invalidMessage}`} />
            ) : error ? (
              <StatusMessage error={describeReadError(error)} />
            ) : null}
            {invalidMessage || !error || !(error.status === 0 || error.status >= 500) ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                本次读取没有改变任何服务端状态；原待核记录与责任保持不变。
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                重试读取
              </Button>
              <Button type="button" size="sm" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        ) : null}
        {phase === "ready" && presentation ? (
          <div className="space-y-3">
            <div
              className={
                presentation.tone === "success"
                  ? "rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400"
                  : presentation.tone === "danger"
                    ? "rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs leading-relaxed text-rose-500 dark:text-rose-400"
                    : presentation.tone === "warning"
                      ? "rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-600 dark:text-amber-400"
                      : "rounded-md border border-border bg-surface-raised/60 p-3 text-xs leading-relaxed text-muted-foreground"
              }
            >
              <p className="font-medium">{presentation.title}</p>
              {presentation.lines.map((line) => (
                <p key={line} className="mt-1">
                  {line}
                </p>
              ))}
              {presentation.targetNote ? <p className="mt-1">{presentation.targetNote}</p> : null}
            </div>
            {showsRefresh ? (
              refresh === "loading" ? (
                <p className="text-[11px] text-muted-foreground">正在读取当前会话状态…</p>
              ) : refresh === "ok" ? (
                <p className="text-[11px] text-emerald-700 dark:text-emerald-400">当前会话状态已按服务端事实更新。</p>
              ) : refresh === "failed" ? (
                <div className="space-y-2">
                  <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                    原命令已确认完成；但当前会话状态读取失败。页面上的 PIN/会话事实可能仍然过时，请刷新确认后再操作。
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      setRefresh("loading");
                      const ok = await refreshCurrent().catch(() => false);
                      setRefresh(ok ? "ok" : "failed");
                    }}
                  >
                    <Icons.RefreshCw size={14} />
                    <span>刷新当前状态</span>
                  </Button>
                </div>
              ) : null
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              {dismissable && record ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onDismissRecord(record.commandId);
                    onClose();
                  }}
                >
                  隐藏提醒（结果仍未确认）
                </Button>
              ) : null}
              {result?.status === "completed" && result.action === "backup-codes.generate" ? (
                <Button type="button" variant="secondary" size="sm" onClick={onRegenerateBackupCodes}>
                  <Icons.RefreshCw size={14} />
                  <span>重新生成备份码</span>
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={onClose}>
                知道了
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              隐藏只影响本机提醒，不代表已核清；责任记录会保留。需要再次操作时请重新发起一次新的操作。
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function pendingStatusLine(record: PendingRecord): string {
  if (record.dismissed === true) return record.outcome === "unknown" ? "已隐藏提醒 · 结果待核对" : "已隐藏提醒 · 结果仍未确认";
  if (record.outcome === "unknown") return "结果待核对";
  if (record.outcome === "unconfirmed") return "已核对：未找到记录（不证明未执行）";
  if (record.outcome === "expired") return "已核对：超过可核对期（不推断未执行）";
  const generation = record.result?.generation;
  return typeof generation === "number" ? `第 ${generation} 代已生成，新码未交付` : "已生成，新码未交付";
}

export function PendingRecordsBlock({
  records,
  dismissed,
  storeWarning,
  currentSessionId,
  onLookup,
  onDismiss,
  onUndismiss,
}: {
  records: PendingRecord[];
  dismissed: PendingRecord[];
  storeWarning?: string;
  currentSessionId: string;
  onLookup: (commandId: string) => void;
  onDismiss: (commandId: string) => void;
  onUndismiss: (commandId: string) => void;
}) {
  const [showDismissed, setShowDismissed] = useState(false);
  if (records.length === 0 && dismissed.length === 0 && !storeWarning) return null;
  const renderRow = (record: PendingRecord, isDismissed: boolean) => (
    <li
      key={record.commandId}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface/60 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          {actionLabel(record.action)}
          <span className="ml-2 text-muted-foreground">{pendingStatusLine(record)}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          首次提交于 {formatDate(record.createdAt)}
          {record.outcome === "completed"
            ? " · 如需可用备份码请重新生成（需再次输入当前密码）"
            : " · 原作用对象为" + (record.targetKind === "session" ? (record.targetSessionId === currentSessionId ? "当前会话" : "更早的会话") : "管理员凭据")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onLookup(record.commandId)}>
          {record.outcome === "completed" ? "查看说明与下一步" : "核对结果"}
        </Button>
        {isDismissed ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onUndismiss(record.commandId)}>
            恢复提醒
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(record.commandId)}>
            隐藏提醒
          </Button>
        )}
      </div>
    </li>
  );
  return (
    <section aria-label="待核对的安全操作" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-2">
        <Icons.AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">待核对的安全操作</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              以下操作未收到明确结果或新码未交付。请先核对结果，不要重复提交相同旧凭据；隐藏提醒不代表已核清。
            </p>
          </div>
          {storeWarning ? <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">{storeWarning}</p> : null}
          {records.length > 0 ? <ul className="space-y-2">{records.map((record) => renderRow(record, false))}</ul> : null}
          {dismissed.length > 0 ? (
            <div className="space-y-2">
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => setShowDismissed((value) => !value)}
              >
                {showDismissed ? "收起已隐藏的提醒" : `另有 ${dismissed.length} 条未核清记录已隐藏提醒`}
              </button>
              {showDismissed ? <ul className="space-y-2">{dismissed.map((record) => renderRow(record, true))}</ul> : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
