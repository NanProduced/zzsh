import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Icons } from "../components/icons";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";
import {
  adminRequest,
  friendlyError,
  formatDate,
  hasPermission,
  type AdminDirectoryEntry,
  type SessionSnapshot,
} from "../api";
import { RecoveryView } from "../views/recovery-view";

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return (
    <span className={`status-badge ${tone}`}>
      <i />
      {children}
    </span>
  );
}

function PasswordChangePanel({ onRefresh, onDirtyChange }: { onRefresh: () => Promise<SessionSnapshot>; onDirtyChange?: (dirty: boolean) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  useEffect(() => {
    onDirtyChange?.(open && (currentPassword.length > 0 || newPassword.length > 0 || confirmPassword.length > 0));
  }, [confirmPassword, currentPassword, newPassword, onDirtyChange, open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mismatch || newPassword.length < 12) return;
    setError(undefined);
    setSuccess(undefined);
    setLoading(true);
    try {
      await adminRequest("/auth/change-password", { currentPassword, newPassword, revokeOtherSessions: true });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("登录密码已更新，其他管理会话已撤销。");
      setOpen(false);
      await onRefresh();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="section-panel">
      <div className="panel-heading">
        <div>
          <h3>修改登录密码</h3>
          <p>日常改密需要当前完整会话验证；保存后自动撤销其他设备会话。</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "打开"}
        </Button>
      </div>
      {open ? (
        <form onSubmit={submit} className="max-w-md space-y-3" noValidate>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">当前密码</label>
            <PasswordInput autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="h-9 px-3 rounded text-xs border border-border bg-surface-raised" required />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">新密码（至少 12 位）</label>
            <PasswordInput autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="h-9 px-3 rounded text-xs border border-border bg-surface-raised" required />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">确认新密码</label>
            <PasswordInput autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="h-9 px-3 rounded text-xs border border-border bg-surface-raised" required />
          </div>
          {mismatch ? <p className="text-xs text-rose-400">两次输入的新密码不一致。</p> : null}
          <StatusMessage error={error} success={success} />
          <Button type="submit" size="sm" loading={loading} disabled={!currentPassword || newPassword.length < 12 || mismatch}>更新登录密码</Button>
        </form>
      ) : null}
    </section>
  );
}

function PinPanel({
  snapshot,
  onRefresh,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onRefresh: () => Promise<SessionSnapshot>;
}) {
  const [pinMode, setPinMode] = useState<"set" | "change">(snapshot.session.pinConfigured ? "change" : "set");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState<string>();
  const [pinSuccess, setPinSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(!snapshot.session.pinConfigured);

  const submitPin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPinError(undefined);
    setPinSuccess(undefined);
    setLoading(true);
    let saved = false;
    try {
      await adminRequest(`/security/pin/${pinMode}`, pinMode === "set" ? { pin: newPin } : { currentPin, newPin });
      saved = true;
      setCurrentPin("");
      setNewPin("");
      setPinSuccess(pinMode === "set" ? "会话 PIN 已设置。" : "会话 PIN 已更新。");
    } catch (error) {
      setPinError(friendlyError(error));
    }
    if (saved) {
      try {
        const next = await onRefresh();
        if (next.authenticated) setPinMode(next.session.pinConfigured ? "change" : "set");
      } catch {
        setPinError("PIN 已保存，但状态刷新失败；请刷新页面。");
      }
    }
    setLoading(false);
  };

  return (
    <section className="section-panel">
      <div className="panel-heading">
        <div>
          <h3>会话快捷 PIN</h3>
          <p>{snapshot.session.pinConfigured ? "已配置。更改 PIN 需要当前 PIN。" : "首次设置 6 位数字 PIN 后，桌面会话可快速锁定。"}</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((value) => !value)}>{open ? "收起" : snapshot.session.pinConfigured ? "更改 PIN" : "设置 PIN"}</Button>
      </div>
      {open ? (
        <form onSubmit={submitPin} className="space-y-3 max-w-sm" noValidate>
          {pinMode === "change" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground block">当前 PIN</label>
              <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full h-9 px-3 rounded border border-border bg-surface-raised font-mono text-xs text-foreground" required />
            </div>
          ) : null}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">{pinMode === "set" ? "设置 6 位数字 PIN" : "新的 6 位 PIN"}</label>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" className="w-full h-9 px-3 rounded border border-border bg-surface-raised font-mono text-xs text-foreground" required />
          </div>
          <StatusMessage error={pinError} success={pinSuccess} />
          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" size="sm" loading={loading} disabled={newPin.length !== 6 || (pinMode === "change" && currentPin.length !== 6)}>{pinMode === "set" ? "设置 PIN" : "更新 PIN"}</Button>
            {snapshot.session.pinConfigured ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPinMode((mode) => (mode === "set" ? "change" : "set"))}>{pinMode === "set" ? "改为更新" : "重新设置"}</Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function FreezePanel({ snapshot }: { snapshot: Extract<SessionSnapshot, { authenticated: true }> }) {
  const [action, setAction] = useState<"freeze" | "unfreeze">("freeze");
  const [admins, setAdmins] = useState<AdminDirectoryEntry[]>([]);
  const [targetAdminId, setTargetAdminId] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const loadAdmins = useCallback(async () => {
    try {
      const result = await adminRequest<{ admins?: AdminDirectoryEntry[] }>("/security/admins");
      setAdmins(result.admins ?? []);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  }, []);

  const canFreeze = hasPermission(snapshot, "admin.account.freeze") || hasPermission(snapshot, "admin.account.unfreeze");
  useEffect(() => {
    if (canFreeze) void loadAdmins();
  }, [canFreeze, loadAdmins]);
  if (!canFreeze) return null;
  const visibleAdmins = snapshot.security.isBoss ? admins : admins.filter((item) => !item.isBoss);
  const target = visibleAdmins.find((item) => item.id === targetAdminId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest(`/security/${action}`, { targetAdminId, password, totpCode, reason });
      setMessage(action === "freeze" ? "目标账号已冻结。" : "目标账号已解冻，需重新验证登录。");
      setPassword("");
      setTotpCode("");
      setReason("");
      await loadAdmins();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="section-panel">
      <div className="panel-heading">
        <div>
          <h3>冻结或解冻管理员</h3>
          <p>目标从列表选择。页面不会要求填写内部 ID。</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "打开"}</Button>
      </div>
      {open ? (
        <form onSubmit={submit} className="space-y-4 max-w-xl" noValidate>
          <div className="flex p-1 rounded bg-surface-raised border border-border w-48">
            <button type="button" onClick={() => setAction("freeze")} className={`flex-1 py-1 text-xs font-medium rounded ${action === "freeze" ? "bg-foreground text-background" : "text-muted-foreground"}`}>冻结账号</button>
            <button type="button" onClick={() => setAction("unfreeze")} className={`flex-1 py-1 text-xs font-medium rounded ${action === "unfreeze" ? "bg-foreground text-background" : "text-muted-foreground"}`}>解除冻结</button>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">目标管理员</label>
            <select value={targetAdminId} onChange={(event) => setTargetAdminId(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs text-foreground" required>
              <option value="">选择管理员账号</option>
              {visibleAdmins.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.username} · {item.status === "ACTIVE" ? "正常" : item.status === "FROZEN" ? "冻结" : "待绑定"}</option>
              ))}
            </select>
            {target ? <p className="text-[11px] text-muted-foreground">将对 {target.name}（{target.username}）执行{action === "freeze" ? "冻结并下线" : "解冻"}。</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground block">本人密码</label>
              <PasswordInput autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-9 px-3 rounded border border-border bg-surface-raised text-xs" required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground block">本人 6 位 TOTP</label>
              <input type="text" inputMode="numeric" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required />
            </div>
          </div>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs text-foreground" placeholder="填写本次安全操作的具体原因" required />
          <StatusMessage error={error} success={message} />
          <Button type="submit" variant={action === "freeze" ? "danger" : "secondary"} size="sm" loading={loading} disabled={!targetAdminId || !password || totpCode.length !== 6 || !reason.trim()}>{action === "freeze" ? "确认冻结账号" : "确认解除冻结"}</Button>
        </form>
      ) : null}
    </section>
  );
}

export function AccountSecurityPage({
  snapshot,
  idleMinutes,
  onIdleMinutes,
  onLock,
  onRefresh,
  onRecoveryCompleted,
  onDirtyChange,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onLock: () => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onRecoveryCompleted: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">账号安全</h2>
          <p className="text-xs text-muted-foreground mt-1">安全设置作用于当前管理员与当前会话；服务端状态具有最高权威。</p>
        </div>
        <Badge tone={snapshot.security.status === "ACTIVE" ? "success" : "warning"}>{snapshot.security.status === "ACTIVE" ? "安全状态正常" : "待完成绑定"}</Badge>
      </div>
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>当前会话状态</h3>
            <p>终端或标签页变化均无法绕过服务端安全检查。</p>
          </div>
          <Icons.ShieldCheck size={20} className="text-muted-foreground" />
        </div>
        <div className="facts-grid">
          <div><span>管理员账号</span><strong>{snapshot.user.displayUsername || snapshot.user.username || "兼容字段"}</strong></div>
          <div><span>双因素验证 (TOTP)</span><strong>{snapshot.user.twoFactorEnabled ? "已启用" : "待完成"}</strong></div>
          <div><span>快捷 PIN</span><strong>{snapshot.session.pinConfigured ? "已配置" : "未配置"}</strong></div>
          <div><span>会话过期时间</span><strong>{formatDate(snapshot.session.expiresAt)}</strong></div>
        </div>
      </section>
      <PinPanel snapshot={snapshot} onRefresh={onRefresh} />
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>闲置锁定</h3>
            <p>偏好保存在本浏览器，由服务端会话强制生效。</p>
          </div>
        </div>
        <div className="max-w-sm space-y-4">
          <select value={idleMinutes} onChange={(event) => onIdleMinutes(Number(event.target.value))} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs text-foreground">
            <option value={5}>5 分钟</option>
            <option value={15}>15 分钟</option>
            <option value={30}>30 分钟</option>
            <option value={60}>60 分钟</option>
          </select>
          <Button type="button" variant="secondary" size="sm" disabled={snapshot.session.locked || !snapshot.session.pinConfigured} onClick={onLock} className="w-full">
            <Icons.Lock size={14} />
            <span>立即锁定当前会话</span>
          </Button>
          {!snapshot.session.pinConfigured ? <p className="text-[11px] text-muted-foreground">请先设置 6 位 PIN，设置后方可启用锁定。</p> : null}
        </div>
      </section>
      <PasswordChangePanel onRefresh={onRefresh} onDirtyChange={onDirtyChange} />
      <section className="section-panel">
        <RecoveryView snapshot={snapshot} onCompleted={onRecoveryCompleted} />
      </section>
      <FreezePanel snapshot={snapshot} />
    </div>
  );
}
