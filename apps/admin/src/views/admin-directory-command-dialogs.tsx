import { useState } from "react";
import { Copy } from "lucide-react";

import { StepUpCaptcha } from "../components/altcha-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PasswordInput, StatusMessage } from "../components/ui-elements";
import { AdminApiError, adminRequest, friendlyError, type AdminDirectoryDetail } from "../api";
import { buildRestoreScopePayload } from "../lib/admin-scope-form";
import type { PendingOperation } from "../lib/admin-pending-operations";

/**
 * 「结果未知」= 没有终态证据，既不是成功也不是明确拒绝。
 * status 0 / NETWORK_ERROR 是没收到响应；5xx 是响应可能已在服务端落写后才失败。
 * 只有 4xx 这类明确拒绝才能安全地纠错重试。与 user-directory 信用处置同一判据。
 */
export function isUnknownResult(error: unknown): boolean {
  return error instanceof AdminApiError && (error.status === 0 || error.code === "NETWORK_ERROR" || error.status >= 500);
}

export type SecurityAction = "freeze" | "unfreeze" | "force-logout" | "restore-scope" | "reset-password" | "reset-2fa";

const ACTION_COPY: Record<SecurityAction, { title: string; impact: string; confirm: string; danger: boolean; needsReason: boolean }> = {
  freeze: {
    title: "冻结该管理员",
    impact: "账号状态改为冻结，阻止后续登录与新请求；同时撤销该账号全部现有会话，并使其未完成的账号恢复请求过期。",
    confirm: "确认冻结",
    danger: true,
    needsReason: true,
  },
  unfreeze: {
    title: "解冻该管理员",
    impact: "解除冻结。若该账号已绑定双因素验证且曾完成激活，则恢复正常；否则进入待激活，需要本人重新完成改密与绑定。冻结时被撤销的会话不会复活。",
    confirm: "确认解冻",
    danger: false,
    needsReason: true,
  },
  "force-logout": {
    title: "撤销该管理员全部会话",
    impact: "撤销全部设备会话与未完成登录挑战。账号状态不变，下次登录仍需密码与双因素验证。这不替代冻结：账号仍可重新登录。",
    confirm: "确认撤销会话",
    danger: true,
    needsReason: true,
  },
  "reset-password": {
    title: "重置该管理员的密码",
    impact: "系统生成一次性临时密码，只显示这一次。对方全部会话会被撤销，下次登录必须先改密。已绑定的 2FA 保持不变。",
    confirm: "确认重置密码",
    danger: true,
    needsReason: true,
  },
  "reset-2fa": {
    title: "重置该管理员的 2FA",
    impact: "清除对方当前的 2FA 绑定（例如手机丢失）。对方全部会话会被撤销，下次登录需重新绑定 2FA。密码保持不变。",
    confirm: "确认重置 2FA",
    danger: true,
    needsReason: true,
  },
  "restore-scope": {
    title: "恢复此前指定的游戏范围",
    impact: "重新启用该账号上次保存的指定游戏集合。若没有历史集合或历史集合为空，结果是“无业务范围”，该账号将不能读取任何游戏的业务数据。",
    confirm: "确认恢复范围",
    danger: false,
    // 该动作的请求体只含 username 与 mode，服务端不读原因、审计也不落原因字段，收集后丢弃属虚假必填。
    needsReason: false,
  },
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{children}</span>;
}

export function SecurityActionDialog({
  action,
  target,
  pending,
  blockedReason,
  markPending,
  clearPending,
  onClose,
  onDone,
}: {
  action: SecurityAction;
  target: AdminDirectoryDetail;
  /** P1-B：待确认记录属于（身份,会话,目标,操作），不属于这个弹窗。 */
  pending: PendingOperation | null;
  blockedReason: string | null;
  markPending: (operation: SecurityAction, target: string, path: string, kind: PendingOperation["kind"], requestId?: string) => boolean;
  clearPending: (operation: SecurityAction, target: string) => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copiedCredentials, setCopiedCredentials] = useState(false);
  /** 重置密码返回的一次性临时密码：只在本弹窗显示，显式确认后才关闭。 */
  const [issuedPassword, setIssuedPassword] = useState<string>();
  const copy = ACTION_COPY[action];
  // 恢复范围只是切模式，不撤销访问，因此不要求再验证凭据。
  const needsReauth = action !== "restore-scope";
  const ready =
    (!needsReauth || (password.length >= 12 && totpCode.length === 6)) &&
    (!copy.needsReason || reason.trim().length >= 3);

  const submit = async () => {
    setError(undefined);
    const path =
      action === "freeze" ? "/security/freeze"
      : action === "unfreeze" ? "/security/unfreeze"
      : action === "force-logout" ? "/security/admins/force-logout"
      : action === "reset-password" ? "/security/admins/reset-password"
      : action === "reset-2fa" ? "/security/admins/reset-2fa"
      : "/security/admins/scope";
    if (pending || busy || blockedReason) return;
    if (!markPending(action, target.username, path, "UNKNOWN")) {
      setError("当前浏览器无法保存原操作记录，未提交任何写请求。请恢复站点存储后重试。");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> =
        action === "restore-scope"
          ? buildRestoreScopePayload(target.username)
          : { targetAdminId: target.id, password, totpCode, reason: reason.trim() };
      const result = await adminRequest<{ status?: string; temporaryPassword?: string }>(path, body);
      clearPending(action, target.username);
      if (action === "reset-password") {
        if (typeof result.temporaryPassword === "string" && result.temporaryPassword) setIssuedPassword(result.temporaryPassword);
        else setError("密码已重置，但没有收到临时密码。请重新重置一次以获得新的临时密码。");
        return;
      }
      if (action === "reset-2fa") {
        onDone("已清除该账号的 2FA 绑定，其全部会话已撤销；对方下次登录需重新绑定 2FA。");
        return;
      }
      onDone(
        action === "freeze"
          ? "该账号已冻结，现有会话与未完成的恢复请求已一并处理。"
          : action === "unfreeze"
            ? result.status === "PENDING_ENROLLMENT"
              ? "该账号已解除冻结，但进入待激活：需要本人重新完成改密并绑定双因素验证后才能登录。"
              : "该账号已解冻并恢复正常登录能力。冻结期间被撤销的会话不会复活。"
            : action === "force-logout"
              ? "该账号的会话与未完成登录挑战已撤销。账号仍可重新登录。"
              : "业务范围已按上次集合尝试恢复。",
      );
    } catch (failure) {
      if (!isUnknownResult(failure)) {
        clearPending(action, target.username);
        setError(friendlyError(failure));
      }
      // 结果未知：记录保留，关闭重开也还是锁定状态。
    } finally {
      setBusy(false);
    }
  };

  if (issuedPassword) {
    return (
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent className="w-full sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>交付临时密码</DialogTitle>
            <DialogDescription>临时密码只在此显示一次，关闭后无法再次查看。</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/70 bg-foreground/[0.04] p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">登录账号</p>
                <p className="mt-1 font-mono text-sm text-foreground">{target.username}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">临时密码</p>
                <p className="mt-1 font-mono text-sm text-foreground">{issuedPassword}</p>
              </div>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">请当面交付或走既有安全通道。对方下次登录必须先改密。</p>
          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const text = `登录账号：${target.username}\n临时密码：${issuedPassword}\n对方下次登录必须先改密。`;
                void navigator.clipboard?.writeText(text);
                setCopiedCredentials(true);
                setTimeout(() => setCopiedCredentials(false), 2000);
              }}
            >
              <Copy className="mr-1.5 size-3.5" />
              {copiedCredentials ? "已复制" : "复制全部凭据"}
            </Button>
            <Button type="button" size="sm" onClick={() => { setIssuedPassword(undefined); onDone(`已确认抄录 ${target.username} 的临时密码，其全部会话已撤销。`); }}>
              我已抄录并关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            目标：{target.name}（{target.username}）。{copy.impact}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
          <StatusMessage error={error} />
          {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
          {pending ? (
            <p className="rounded-md bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-300">
              该目标上这个操作的请求结果无法确认{pending.requestId ? `（请求编号 ${pending.requestId}）` : ""}，可能已经生效。
              当前接口没有原操作终态回执，因此这里不能再次提交；关闭重开也不会解除，只能按账号当前事实人工核对。
            </p>
          ) : null}
          {needsReauth ? (
            <>
              <label className="block">
                <FieldLabel>本人密码</FieldLabel>
                <PasswordInput
                  autoComplete="current-password"
                  disabled={Boolean(pending || blockedReason)}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                />
              </label>
              <label className="block">
                <FieldLabel>本人 6 位动态验证码</FieldLabel>
                <Input
                  inputMode="numeric"
                  maxLength={6}
                  disabled={Boolean(pending || blockedReason)}
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </label>
            </>
          ) : null}
          <StepUpCaptcha />
          {copy.needsReason ? (
          <label className="block">
            <FieldLabel>原因（写入审计）</FieldLabel>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="例：员工离职注销权限、岗位季度安全例行轮换"
              className="min-h-16 text-sm"
            />
          </label>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 py-3">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" size="sm" variant={copy.danger ? "danger" : "primary"} loading={busy} disabled={!ready || Boolean(pending || blockedReason)} onClick={() => void submit()}>
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
