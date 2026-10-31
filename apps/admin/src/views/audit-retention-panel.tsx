import { useEffect, useState } from "react";

import { Trash2Icon } from "lucide-react";

import { adminRequest } from "../api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PasswordInput, StatusMessage } from "../components/ui-elements";
import { StepUpCaptcha } from "../components/altcha-field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";

export const RETENTION_MIN_DAYS = 90;
export const RETENTION_MAX_DAYS = 3650;
export const RETENTION_DEFAULT_DAYS = 180;

export function retentionConfirmText(days: number): string {
  return `删除${days}天前的日志`;
}

export function validRetentionDays(value: string): number | undefined {
  if (!/^\d{1,4}$/.test(value)) return undefined;
  const days = Number(value);
  return days >= RETENTION_MIN_DAYS && days <= RETENTION_MAX_DAYS ? days : undefined;
}

type Preview = { retentionDays: number; cutoff: string | null; purgeableCount: number };

function beijing(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** Boss 专用：手动清理 N 天前的账号/安全类日志（≥90 天，默认 180）。需二次验证 + 输入确认口令，清理本身永久记审计。 */
export function AuditRetentionPanel({ onPurged }: { onPurged?: () => void }) {
  const [daysText, setDaysText] = useState(String(RETENTION_DEFAULT_DAYS));
  const days = validRetentionDays(daysText);
  const [preview, setPreview] = useState<Preview>();
  const [previewError, setPreviewError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  useEffect(() => {
    setPreview(undefined);
    setPreviewError(undefined);
    if (!days) return;
    let alive = true;
    const timer = setTimeout(() => {
      adminRequest<Preview>(`/security/audit/purge/preview?retentionDays=${days}`)
        .then((result) => { if (alive) setPreview(result); })
        .catch((error: unknown) => { if (alive) setPreviewError(error instanceof Error ? error.message : "预览失败"); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [days]);

  const ready = Boolean(days) && password.length > 0 && /^\d{6}$/.test(totpCode) && days !== undefined && confirm === retentionConfirmText(days);

  const close = () => { setOpen(false); setPassword(""); setTotpCode(""); setConfirm(""); };

  const run = async () => {
    if (!ready || !days) return;
    setBusy(true);
    try {
      const result = await adminRequest<{ deletedCount: number }>("/security/audit/purge", { retentionDays: days, confirmText: confirm, password, totpCode });
      setMessage({ tone: "success", text: `已清理 ${result.deletedCount} 条 ${days} 天前的账号与安全日志，本次清理已记入审计。` });
      close();
      onPurged?.();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "清理失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section-panel">
      <div className="panel-heading">
        <div>
          <h3>日志保留与清理</h3>
          <p>手动删除指定天数之前的账号、登录与会话类日志，至少保留 {RETENTION_MIN_DAYS} 天。订单、资金、审批等业务日志不在清理范围；每次清理都会永久记录，且清理记录本身不会被删除。</p>
        </div>
        <Trash2Icon size={20} className="text-muted-foreground" />
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">保留最近（天）</span>
          <Input inputMode="numeric" value={daysText} onChange={(event) => setDaysText(event.target.value.replace(/\D/g, "").slice(0, 4))} className="w-32" aria-invalid={!days || undefined} />
        </label>
        <p className="text-xs text-muted-foreground pb-2">
          {!days ? `请输入 ${RETENTION_MIN_DAYS}–${RETENTION_MAX_DAYS} 之间的天数`
            : previewError ? previewError
            : preview ? `${beijing(preview.cutoff)}（北京时间）之前可清理 ${preview.purgeableCount} 条`
            : "正在统计…"}
        </p>
        <Button type="button" size="sm" variant="destructive" disabled={!days || !preview || preview.purgeableCount === 0} onClick={() => setOpen(true)}>清理旧日志</Button>
      </div>
      {message ? <div className="mt-3"><StatusMessage error={message.tone === "error" ? message.text : undefined} success={message.tone === "success" ? message.text : undefined} /></div> : null}
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清理 {days} 天前的日志</DialogTitle>
            <DialogDescription>将永久删除 {preview?.purgeableCount ?? 0} 条账号与安全日志，无法恢复。</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void run(); }}>
            <label className="block space-y-1">
              <span className="text-xs font-medium">请输入「{days ? retentionConfirmText(days) : ""}」以确认</span>
              <Input value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">本人密码</span>
              <PasswordInput autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none!" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">6 位动态验证码</span>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
            </label>
            <StepUpCaptcha />
          </form>
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={close}>取消</Button>
            <Button type="button" size="sm" variant="destructive" disabled={!ready || busy} onClick={() => void run()}>{busy ? "清理中…" : "确认清理"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
