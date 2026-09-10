import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

import { AuthLayout } from "./components/auth-layout";
import { BrandLogo } from "./components/brand-logo";
import { Icons } from "./components/icons";
import { ThemeToggle, Button, PasswordInput, StatusMessage } from "./components/ui-elements";

import { LoginView } from "./views/login-view";
import { ChallengeView } from "./views/challenge-view";
import { OnboardingView } from "./views/onboarding-view";
import { RecoveryView } from "./views/recovery-view";
import { LockScreen } from "./views/lock-screen";

import {
  adminRequest,
  friendlyError,
  formatDate,
  readIdleMinutes,
  signal,
  CHANNEL_NAME,
  EVENT_KEY,
  IDLE_KEY,
  type Theme,
  type View,
  type SignalEvent,
  type SessionSnapshot,
  type AuthResponse,
  type EnrollmentResponse,
  type AdminDirectoryEntry,
} from "./api";

function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1024px)").matches
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

function useIdleLock(
  enabled: boolean,
  minutes: number,
  sessionId: string | undefined,
  onIdle: () => void
): void {
  const lastActivity = useRef(Date.now());
  const callback = useRef(onIdle);
  callback.current = onIdle;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    lastActivity.current = Date.now();
    let lastBroadcastAt = 0;

    const mark = (at: number, broadcast: boolean) => {
      if (!Number.isFinite(at) || at <= lastActivity.current) return;
      lastActivity.current = at;
      if (broadcast && at - lastBroadcastAt >= 2_000) {
        lastBroadcastAt = at;
        signal("activity", sessionId, at);
      }
    };

    const localActivity = () => mark(Date.now(), true);
    const remoteActivity = (event: Event) => {
      const detail = (event as CustomEvent<SignalEvent>).detail;
      if (detail?.sessionId === sessionId) mark(detail.at, false);
    };

    const events = ["pointerdown", "keydown", "touchstart", "mousemove"] as const;
    for (const event of events) window.addEventListener(event, localActivity, { passive: true });
    window.addEventListener("zzsh:activity", remoteActivity);

    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= minutes * 60_000) {
        lastActivity.current = Date.now();
        callback.current();
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("zzsh:activity", remoteActivity);
      for (const event of events) window.removeEventListener(event, localActivity);
    };
  }, [enabled, minutes, sessionId]);
}

// ----------------------------------------------------
// WORKBENCH PANELS (Post-Auth Administration)
// ----------------------------------------------------

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <span className={`status-badge ${tone}`}>
      <i />
      {children}
    </span>
  );
}

function PasswordChangePanel({ onRefresh }: { onRefresh: () => Promise<SessionSnapshot> }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mismatch || newPassword.length < 12) return;
    setError(undefined);
    setSuccess(undefined);
    setLoading(true);
    try {
      await adminRequest("/auth/change-password", {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("登录密码已更新，其他管理会话已撤销。");
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
        <Icons.Key size={20} className="text-muted-foreground" />
      </div>
      <form onSubmit={submit} className="max-w-md space-y-3" noValidate>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground block">当前密码</label>
          <PasswordInput
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="h-9 px-3 rounded text-xs border border-border bg-surface-raised"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground block">新密码（至少 12 位）</label>
          <PasswordInput
            autoComplete="new-password"
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-9 px-3 rounded text-xs border border-border bg-surface-raised"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground block">确认新密码</label>
          <PasswordInput
            autoComplete="new-password"
            minLength={12}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="h-9 px-3 rounded text-xs border border-border bg-surface-raised"
            required
          />
        </div>
        {mismatch && <p className="text-xs text-rose-400">两次输入的新密码不一致。</p>}
        <StatusMessage error={error} success={success} />
        <Button
          type="submit"
          size="sm"
          loading={loading}
          disabled={!currentPassword || newPassword.length < 12 || mismatch}
        >
          更新登录密码
        </Button>
      </form>
    </section>
  );
}

function SecurityPanel({
  snapshot,
  idleMinutes,
  onIdleMinutes,
  onLock,
  onRefresh,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onLock: () => void;
  onRefresh: () => Promise<SessionSnapshot>;
}) {
  const [pinMode, setPinMode] = useState<"set" | "change">(
    snapshot.session.pinConfigured ? "change" : "set"
  );
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState<string>();
  const [pinSuccess, setPinSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);

  const submitPin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPinError(undefined);
    setPinSuccess(undefined);
    setLoading(true);
    let saved = false;
    try {
      await adminRequest(
        `/security/pin/${pinMode}`,
        pinMode === "set" ? { pin: newPin } : { currentPin, newPin }
      );
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">账号安全</h2>
          <p className="text-xs text-muted-foreground mt-1">
            安全设置作用于当前管理员与当前会话；服务端状态具有最高权威。
          </p>
        </div>
        <Badge tone={snapshot.security.status === "ACTIVE" ? "success" : "warning"}>
          {snapshot.security.status === "ACTIVE" ? "安全状态正常" : "待完成绑定"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* PIN Configuration */}
        <div className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>会话快捷 PIN</h3>
              <p>用于桌面会话快速恢复。连续 5 次错误后须用密码+验证器重设。</p>
            </div>
            <Icons.Key size={20} className="text-muted-foreground" />
          </div>

          <form onSubmit={submitPin} className="space-y-3" noValidate>
            {pinMode === "change" && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground block">当前 PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={currentPin}
                  onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full h-9 px-3 rounded border border-border bg-surface-raised font-mono text-xs text-foreground"
                  required
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground block">
                {pinMode === "set" ? "设置 6 位数字 PIN" : "新的 6 位 PIN"}
              </label>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                maxLength={6}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="••••••"
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised font-mono text-xs text-foreground"
                required
              />
            </div>

            <StatusMessage error={pinError} success={pinSuccess} />

            <div className="flex items-center gap-2 pt-1">
              <Button
                type="submit"
                size="sm"
                loading={loading}
                disabled={newPin.length !== 6 || (pinMode === "change" && currentPin.length !== 6)}
              >
                {pinMode === "set" ? "设置 PIN" : "更新 PIN"}
              </Button>
              {snapshot.session.pinConfigured && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPinMode((m) => (m === "set" ? "change" : "set"))}
                >
                  {pinMode === "set" ? "改为更新" : "重新设置"}
                </Button>
              )}
            </div>
          </form>
        </div>

        {/* Idle lock configuration */}
        <div className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>闲置锁定</h3>
              <p>偏好保存在本浏览器，由服务端会话强制生效。</p>
            </div>
            <Icons.Lock size={20} className="text-muted-foreground" />
          </div>

          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground block">闲置超时时长</label>
              <select
                value={idleMinutes}
                onChange={(e) => onIdleMinutes(Number(e.target.value))}
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs text-foreground"
              >
                <option value={5}>5 分钟</option>
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>60 分钟</option>
              </select>
            </div>

            <div className="pt-2 border-t border-border">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={snapshot.session.locked || !snapshot.session.pinConfigured}
                onClick={onLock}
                className="w-full"
              >
                <Icons.Lock size={14} />
                <span>立即锁定当前会话</span>
              </Button>
              {!snapshot.session.pinConfigured && (
                <p className="text-[11px] text-muted-foreground mt-1.5 text-center">
                  请先在左侧设置 6 位 PIN，设置后方可启用锁定。
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <PasswordChangePanel onRefresh={onRefresh} />

      {/* Session facts */}
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>当前会话状态</h3>
            <p>终端或标签页变化均无法绕过服务端安全检查。</p>
          </div>
          <Icons.ShieldCheck size={20} className="text-muted-foreground" />
        </div>
        <div className="facts-grid">
          <div>
            <span>管理员账号</span>
            <strong>{snapshot.user.displayUsername || snapshot.user.username || "兼容字段"}</strong>
          </div>
          <div>
            <span>双因素验证 (TOTP)</span>
            <strong>{snapshot.user.twoFactorEnabled ? "已启用" : "待完成"}</strong>
          </div>
          <div>
            <span>快捷 PIN</span>
            <strong>{snapshot.session.pinConfigured ? "已配置" : "未配置"}</strong>
          </div>
          <div>
            <span>会话过期时间</span>
            <strong>{formatDate(snapshot.session.expiresAt)}</strong>
          </div>
        </div>
      </section>
    </div>
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

  const loadAdmins = useCallback(async () => {
    try {
      const result = await adminRequest<{ admins?: AdminDirectoryEntry[] }>("/security/admins");
      setAdmins(result.admins ?? []);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  }, []);

  useEffect(() => {
    if (snapshot.security.isBoss) void loadAdmins();
  }, [loadAdmins, snapshot.security.isBoss]);

  if (!snapshot.security.isBoss) return null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest(`/security/${action}`, {
        targetAdminId,
        password,
        totpCode,
        reason,
      });
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
          <h3>同级管理员安全协作</h3>
          <p>冻结或解冻管理员；目标须从列表选择，受服务端审计约束。</p>
        </div>
        <Icons.AlertCircle size={20} className="text-muted-foreground" />
      </div>

      <form onSubmit={submit} className="space-y-4 max-w-xl" noValidate>
        <div className="flex p-1 rounded bg-surface-raised border border-border w-48">
          <button
            type="button"
            onClick={() => setAction("freeze")}
            className={`flex-1 py-1 text-xs font-medium rounded transition-colors ${
              action === "freeze" ? "bg-foreground text-background" : "text-muted-foreground"
            }`}
          >
            冻结账号
          </button>
          <button
            type="button"
            onClick={() => setAction("unfreeze")}
            className={`flex-1 py-1 text-xs font-medium rounded transition-colors ${
              action === "unfreeze" ? "bg-foreground text-background" : "text-muted-foreground"
            }`}
          >
            解除冻结
          </button>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground block">目标管理员</label>
          <select
            value={targetAdminId}
            onChange={(e) => setTargetAdminId(e.target.value)}
            className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs text-foreground"
            required
          >
            <option value="">选择管理员账号</option>
            {admins.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.username} · {item.status === "ACTIVE" ? "正常" : item.status === "FROZEN" ? "冻结" : "待绑定"}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">本人密码</label>
            <PasswordInput
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-9 px-3 rounded border border-border bg-surface-raised text-xs"
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground block">本人 6 位 TOTP</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono"
              required
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground block">操作原因（审计存证）</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs text-foreground"
            placeholder="填写本次安全操作的具体原因"
            required
          />
        </div>

        <StatusMessage error={error} success={message} />

        <Button
          type="submit"
          variant={action === "freeze" ? "danger" : "secondary"}
          size="sm"
          loading={loading}
          disabled={!targetAdminId || !password || totpCode.length !== 6 || !reason.trim()}
        >
          {action === "freeze" ? "确认冻结账号" : "确认解除冻结"}
        </Button>
      </form>
    </section>
  );
}

function OverviewPanel({ snapshot }: { snapshot: Extract<SessionSnapshot, { authenticated: true }> }) {
  return (
    <div className="space-y-6">
      <div className="p-8 rounded-xl bg-surface border border-border flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">欢迎进入管理控制台</h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-lg leading-relaxed">
            当前身份认证与双因素安全闭环已就绪。业务订单与履约数据接入后，将根据管理员的角色权限呈现对应视角。
          </p>
        </div>
        <div className="hidden sm:flex flex-col items-center justify-center w-20 h-20 rounded-xl bg-surface-raised border border-border">
          <Icons.ShieldCheck size={28} className="text-emerald-400" />
          <span className="text-[10px] font-mono mt-1 text-muted-foreground font-semibold">
            {snapshot.security.isBoss ? "BOSS" : "ADMIN"}
          </span>
        </div>
      </div>
    </div>
  );
}

function AdminShell({
  snapshot,
  theme,
  onToggleTheme,
  idleMinutes,
  onIdleMinutes,
  onLock,
  onSignOut,
  onRefresh,
  onRecoveryCompleted,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  theme: Theme;
  onToggleTheme: () => void;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onLock: () => void;
  onSignOut: () => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onRecoveryCompleted: () => void;
}) {
  const [section, setSection] = useState<"overview" | "security">("security");

  return (
    <div className="shell-grid">
      <aside className="sidebar select-none">
        <div>
          <BrandLogo variant="horizontal" height={34} />
          <div className="sidebar-rule" />
          <nav aria-label="管理平台导航" className="space-y-1">
            <button
              type="button"
              onClick={() => setSection("overview")}
              className={`nav-item ${section === "overview" ? "active" : ""}`}
            >
              <Icons.Menu size={16} />
              <span>工作台</span>
            </button>
            <button
              type="button"
              onClick={() => setSection("security")}
              className={`nav-item ${section === "security" ? "active" : ""}`}
            >
              <Icons.Shield size={16} />
              <span>账号安全</span>
            </button>
          </nav>
        </div>

        <div className="pt-4 border-t border-border space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-surface-raised border border-border flex items-center justify-center font-bold text-xs">
              {(snapshot.user.name || snapshot.user.username || "A").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <strong className="block text-xs font-semibold text-foreground truncate">
                {snapshot.user.name || snapshot.user.username || "管理员"}
              </strong>
              <span className="text-[11px] text-muted-foreground">
                {snapshot.security.isBoss ? "同级 Boss" : "管理员"}
              </span>
            </div>
          </div>
          <div className="text-[10px] font-mono text-muted-foreground flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>LOCAL / FAKE MODE</span>
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <span>洲洲商行</span>
            <Icons.ArrowRight size={12} className="text-muted-foreground" />
            <strong>{section === "security" ? "账号安全" : "工作台"}</strong>
          </div>
          <div className="topbar-actions">
            <span className="topbar-status">
              <i />
              会话正常
            </span>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <button
              type="button"
              onClick={onSignOut}
              aria-label="退出当前会话"
              title="退出登录"
              className="inline-flex items-center justify-center w-8 h-8 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icons.LogOut size={15} />
            </button>
          </div>
        </header>

        <main className="workspace">
          {section === "security" ? (
            <div className="space-y-6">
              <SecurityPanel
                snapshot={snapshot}
                idleMinutes={idleMinutes}
                onIdleMinutes={onIdleMinutes}
                onLock={onLock}
                onRefresh={onRefresh}
              />
              <div className="section-panel">
                <RecoveryView
                  snapshot={snapshot}
                  onCompleted={onRecoveryCompleted}
                />
              </div>
              <FreezePanel snapshot={snapshot} />
            </div>
          ) : (
            <OverviewPanel snapshot={snapshot} />
          )}
        </main>

        <footer className="shell-footer">
          <span>权限、锁屏与操作审计均以服务端为准</span>
          <span>会话到期：{formatDate(snapshot.session.expiresAt)}</span>
        </footer>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// ROOT APP CONTROLLER
// ----------------------------------------------------

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const urlTheme = new URLSearchParams(window.location.search).get("theme");
      if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
      if (window.localStorage.getItem("zzsh-admin-theme") === "light") return "light";
    }
    return "dark";
  });
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [view, setView] = useState<View>("login");

  // Form states
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string | undefined>(undefined);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [recoveryNotice, setRecoveryNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [lockError, setLockError] = useState<string>();
  const [idleMinutes, setIdleMinutes] = useState(readIdleMinutes);

  const mobile = useMobileLayout();
  const sessionIdRef = useRef<string | undefined>(undefined);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("zzsh-admin-theme", theme);
  }, [theme]);

  useEffect(() => {
    sessionIdRef.current = snapshot?.authenticated ? snapshot.session.id : undefined;
  }, [snapshot]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const locked = snapshot?.authenticated === true && snapshot.session.locked;
    shell.classList.toggle("is-locked", locked);
    if (locked) {
      shell.setAttribute("aria-hidden", "true");
      shell.setAttribute("inert", "");
    } else {
      shell.removeAttribute("aria-hidden");
      shell.removeAttribute("inert");
    }
  }, [snapshot]);

  const applySession = useCallback((next: SessionSnapshot, redirect = true) => {
    setSnapshot(next);
    if (!redirect) return;
    if (!next.authenticated) {
      setView("login");
      setPassword("");
      return;
    }
    if (next.security.status === "PENDING_ENROLLMENT") {
      setView("onboarding");
    } else if (!next.user.twoFactorEnabled) {
      setView("onboarding");
    } else {
      setView("app");
    }
  }, []);

  const refreshSession = useCallback(
    async (redirect = false): Promise<SessionSnapshot> => {
      const next = await adminRequest<SessionSnapshot>("/session");
      applySession(next, redirect);
      return next;
    },
    [applySession]
  );

  useEffect(() => {
    void refreshSession(true).catch(() => {
      setSnapshot({ authenticated: false });
      setView("login");
    });
  }, [refreshSession]);

  // Broadcast channel & Storage events for cross-tab session sync
  useEffect(() => {
    const receive = (event: SignalEvent) => {
      if (event.type === "activity") {
        if (event.sessionId === sessionIdRef.current && Number.isFinite(event.at)) {
          window.dispatchEvent(new CustomEvent("zzsh:activity", { detail: event }));
        }
        return;
      }
      if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
      if (event.type === "logout") {
        setSnapshot({ authenticated: false });
        setView("login");
        setPassword("");
        return;
      }
      void refreshSession(true).catch(() => undefined);
    };

    const readSignal = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const data = value as Partial<SignalEvent>;
      const type = data.type;
      if (type !== "locked" && type !== "unlocked" && type !== "logout" && type !== "activity") return;
      receive({
        type,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        at: typeof data.at === "number" ? data.at : 0,
      });
    };

    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event) => readSignal(event.data);
    } catch {
      channel = undefined;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== EVENT_KEY || !event.newValue) return;
      try {
        readSignal(JSON.parse(event.newValue));
      } catch {
        // ignore malformed
      }
    };
    window.addEventListener("storage", onStorage);

    const onFocus = () => {
      if (document.visibilityState === "visible" && view === "app") {
        void refreshSession(true).catch(() => undefined);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      channel?.close();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshSession, view]);

  const lockSession = useCallback(async () => {
    if (
      !snapshot?.authenticated ||
      snapshot.security.status !== "ACTIVE" ||
      !snapshot.session.pinConfigured ||
      snapshot.session.locked
    )
      return;
    try {
      await adminRequest("/security/pin/lock", {});
      signal("locked", snapshot.session.id);
      await refreshSession(false);
    } catch {
      const next = await refreshSession(false).catch(() => null);
      if (next?.authenticated && next.session.locked) signal("locked", next.session.id);
    }
  }, [refreshSession, snapshot]);

  useIdleLock(
    Boolean(
      snapshot?.authenticated &&
        view === "app" &&
        snapshot.security.status === "ACTIVE" &&
        snapshot.session.pinConfigured &&
        !snapshot.session.locked
    ),
    idleMinutes,
    snapshot?.authenticated ? snapshot.session.id : undefined,
    () => void lockSession()
  );

  const toggleTheme = () => setTheme((c) => (c === "dark" ? "light" : "dark"));

  const signOut = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    try {
      await adminRequest("/auth/sign-out", {});
    } catch {
      // ignore
    }
    signal("logout", sessionId);
    setSnapshot({ authenticated: false });
    setView("login");
    setPassword("");
    setTotpURI(undefined);
    setBackupCodes([]);
    setRecoveryNotice(undefined);
  }, []);

  const login = async (idValue: string, pwValue: string) => {
    setError(undefined);
    setRecoveryNotice(undefined);
    setTotpURI(undefined);
    setBackupCodes([]);
    setLoading(true);
    try {
      const isEmail = idValue.includes("@");
      const result = await adminRequest<AuthResponse>(
        isEmail ? "/auth/sign-in" : "/auth/sign-in/username",
        isEmail ? { email: idValue, password: pwValue } : { username: idValue, password: pwValue }
      );
      setPassword(pwValue);
      if (result.twoFactorRedirect) {
        setView("challenge");
      } else {
        await refreshSession(true);
      }
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const verifyChallenge = async (method: "totp" | "backup", code: string) => {
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest(`/auth/two-factor/verify-${method === "totp" ? "totp" : "backup-code"}`, {
        code,
      });
      setPassword("");
      await refreshSession(true);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const changePassword = async (current: string, next: string) => {
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest("/auth/change-password", {
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      setPassword(next);
      await refreshSession(false);
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      setLoading(false);
    }
  };

  const enable2FA = async (pw: string) => {
    setError(undefined);
    setLoading(true);
    try {
      const result = await adminRequest<EnrollmentResponse>("/auth/two-factor/enable", {
        password: pw || password,
      });
      setTotpURI(result.totpURI);
      setBackupCodes(result.backupCodes ?? []);
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      setLoading(false);
    }
  };

  const verify2FA = async (code: string) => {
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest("/auth/two-factor/verify-totp", { code });
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      setLoading(false);
    }
  };

  const activateEnrollment = async () => {
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/enrollment/activate", {});
      await refreshSession(false);
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      setLoading(false);
    }
  };

  const unlock = async (body: Record<string, unknown>) => {
    setLockError(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/pin/unlock", body);
      signal("unlocked", sessionIdRef.current);
      await refreshSession(false);
    } catch (failure) {
      setLockError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const setIdle = (value: number) => {
    if (![5, 15, 30, 60].includes(value)) return;
    setIdleMinutes(value);
    try {
      window.localStorage.setItem(IDLE_KEY, String(value));
    } catch {
      // local preference optional
    }
  };

  if (!snapshot) {
    return (
      <div className="loading-screen">
        <BrandLogo variant="horizontal" height={36} />
        <span className="text-xs font-mono">正在读取管理会话…</span>
      </div>
    );
  }

  // 1. Routine Login
  if (view === "login") {
    return (
      <AuthLayout theme={theme} onToggleTheme={toggleTheme}>
        <LoginView
          identifier={identifier}
          loading={loading}
          error={error}
          onIdentifier={setIdentifier}
          onSubmit={login}
          onRecovery={() => {
            setError(undefined);
            setView("recovery");
          }}
        />
      </AuthLayout>
    );
  }

  // 2. 2FA Challenge
  if (view === "challenge") {
    return (
      <AuthLayout
        theme={theme}
        onToggleTheme={toggleTheme}


      >
        <ChallengeView
          loading={loading}
          error={error}
          onSubmit={verifyChallenge}
          onBack={() => {
            setError(undefined);
            setView("login");
          }}
          onRecovery={() => {
            setError(undefined);
            setView("recovery");
          }}
        />
      </AuthLayout>
    );
  }

  // 3. Onboarding (First-time initialization)
  if (view === "onboarding") {
    const needsPasswordChange = snapshot.authenticated && snapshot.security.passwordChangeRequired;

    // Determine initial step
    const initialStep = needsPasswordChange ? 1 : 2;
    const accountName = snapshot.authenticated
      ? snapshot.user.displayUsername || snapshot.user.username || identifier
      : identifier;

    return (
      <AuthLayout
        theme={theme}
        onToggleTheme={toggleTheme}
        variant="onboarding"


      >
        <OnboardingView
          accountIdentifier={accountName}
          initialStep={initialStep}
          loading={loading}
          error={error}
          cachedPassword={password}
          totpURI={totpURI}
          backupCodes={backupCodes}
          onChangePassword={changePassword}
          onEnable2FA={enable2FA}
          onVerify2FA={verify2FA}
          onActivateEnrollment={activateEnrollment}
          onComplete={async () => {
            const next = await refreshSession(true);
            if (next.authenticated) { setPassword(""); setTotpURI(undefined); setBackupCodes([]); setView("app"); }
          }}
        />
      </AuthLayout>
    );
  }

  // 4. Standalone Recovery
  if (view === "recovery") {
    return (
      <AuthLayout
        theme={theme}
        onToggleTheme={toggleTheme}


      >
        <RecoveryView
          snapshot={snapshot?.authenticated ? snapshot : undefined}
          initialMessage={recoveryNotice}
          onBack={() => {
            setError(undefined);
            setView("login");
          }}
          onCompleted={() => {
            if (sessionIdRef.current) signal("logout", sessionIdRef.current);
            setSnapshot({ authenticated: false });
            setRecoveryNotice("恢复已完成。请使用新密码登录并绑定身份验证器。");
          }}
        />
      </AuthLayout>
    );
  }

  // 5. Authenticated App Shell & Workspace
  if (!snapshot.authenticated) {
    return (
      <AuthLayout theme={theme} onToggleTheme={toggleTheme}>
        <LoginView
          identifier={identifier}
          loading={loading}
          error={error}
          onIdentifier={setIdentifier}
          onSubmit={login}
          onRecovery={() => setView("recovery")}
        />
      </AuthLayout>
    );
  }

  return (
    <div className="admin-app">
      <div ref={shellRef} className="app-shell">
        <AdminShell
          snapshot={snapshot}
          theme={theme}
          onToggleTheme={toggleTheme}
          idleMinutes={idleMinutes}
          onIdleMinutes={setIdle}
          onLock={() => void lockSession()}
          onSignOut={() => void signOut()}
          onRefresh={() => refreshSession(false)}
          onRecoveryCompleted={() => {
            void refreshSession(true);
          }}
        />
      </div>
      {snapshot.session.locked && (
        <LockScreen
          mobile={mobile}
          loading={loading}
          error={lockError}
          onUnlock={(body) => void unlock(body)}
          onSignOut={() => void signOut()}
        />
      )}
    </div>
  );
}

const initialTheme = (() => {
  if (typeof window !== "undefined") {
    const urlTheme = new URLSearchParams(window.location.search).get("theme");
    if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
    if (window.localStorage.getItem("zzsh-admin-theme") === "light") return "light";
  }
  return "dark";
})();

if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = initialTheme;
  document.documentElement.classList.toggle("dark", initialTheme === "dark");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
