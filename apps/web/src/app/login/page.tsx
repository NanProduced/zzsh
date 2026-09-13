"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import {
  accountStatusLabel,
  ageStatusLabel,
  cancellationFailureMessage,
  identityStatusLabel,
  protectedActionReason,
  providerAvailability,
  type UserIdentitySnapshot,
} from "../user-account-status";
import { BrandLogo } from "@/components/brand/brand-logo";

type Mode = "login" | "register" | "recover";
type Account = { name?: string; email?: string; username?: string };
type SessionResponse = { user?: Account; session?: { expiresAt?: string } } | null;
type CancellationResponse = { status: UserIdentitySnapshot["accountStatus"] };

class WebAuthError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function webAuthRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/user${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new WebAuthError(0, "NETWORK_ERROR");
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? (payload as { error?: { code?: string } }).error : undefined;
    throw new WebAuthError(response.status, error?.code ?? "INTERNAL_ERROR");
  }
  return payload as T;
}

function authMessage(error: unknown): string {
  if (!(error instanceof WebAuthError) || error.code === "NETWORK_ERROR") return "服务暂时不可用，请确认本地 API 已启动后重试。";
  if (error.code === "UNAUTHENTICATED") return "身份验证失败，请检查账号和密码。";
  if (error.code === "CONFLICT") return "当前账号状态不允许此操作，请稍后重试。";
  if (error.code === "RATE_LIMITED") return "尝试次数过多，请稍后再试。";
  if (error.code === "INVALID_ARGUMENT") return "请检查输入格式。";
  return "请求未完成，请稍后重试。";
}

function expiryText(expiresAt?: string): string {
  if (!expiresAt) return "服务端会话已建立";
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? "服务端会话已建立" : `会话有效至 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function Status({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p
      className={`rounded-lg p-3 text-xs leading-relaxed border ${
        error
          ? "border-red-500/40 bg-red-500/10 text-red-400"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
      }`}
      role={error ? "alert" : "status"}
    >
      {error ?? success}
    </p>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const returnRef = useRef<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("login");
  const [account, setAccount] = useState<Account | null>(null);
  const [expiresAt, setExpiresAt] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [identity, setIdentity] = useState<UserIdentitySnapshot>();
  const [identityLoading, setIdentityLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [accountClosed, setAccountClosed] = useState(false);

  useEffect(() => {
    void webAuthRequest<SessionResponse>("/get-session").then((session) => {
      setAccount(session?.user ?? null);
      setExpiresAt(session?.session?.expiresAt);
    }).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    returnRef.current = safeReturnTo(new URLSearchParams(window.location.search).get("next"));
  }, []);

  useEffect(() => {
    if (!account || accountClosed) {
      setIdentity(undefined);
      setIdentityLoading(false);
      return;
    }
    let active = true;
    setIdentityLoading(true);
    void webAuthRequest<UserIdentitySnapshot>("/identity/status").then((state) => {
      if (active) setIdentity(state);
    }).catch(() => {
      if (active) setIdentity(undefined);
    }).finally(() => {
      if (active) setIdentityLoading(false);
    });
    return () => { active = false; };
  }, [account, accountClosed]);

  const resetNotice = () => { setError(undefined); setSuccess(undefined); };
  const chooseMode = (next: Mode) => { resetNotice(); setMode(next); if (next !== "recover") setRecoveryReady(false); };

  const submitLogin = async () => {
    const value = identifier.trim();
    const result = value.startsWith("+")
      ? await webAuthRequest<{ user?: Account; session?: { expiresAt?: string } }>("/sign-in/phone-number", { phoneNumber: value, password })
      : await webAuthRequest<{ user?: Account; session?: { expiresAt?: string } }>("/sign-in/username", { username: value, password });
    setAccount(result.user ?? null);
    setExpiresAt(result.session?.expiresAt);
    setAccountClosed(false);
    setPassword("");
    setSuccess("登录成功，服务端会话已建立。");
    if (returnRef.current) router.replace(returnRef.current);
  };

  const submitRegister = async () => {
    const result = await webAuthRequest<{ user?: Account; session?: { expiresAt?: string } }>("/sign-up/email", { email: email.trim(), name: name.trim(), username: username.trim(), password });
    setAccount(result.user ?? null);
    setExpiresAt(result.session?.expiresAt);
    setAccountClosed(false);
    setPassword("");
    setSuccess("账号已创建并登录。");
    if (returnRef.current) router.replace(returnRef.current);
  };

  const requestRecoveryCode = async () => {
    await webAuthRequest("/phone-number/request-password-reset", { phoneNumber: phone.trim() });
    setRecoveryReady(true);
    setSuccess("验证码请求已提交。当前页面不展示 fake outbox 中的验证码，请使用受控测试接缝完成本地验收。");
  };

  const completeRecovery = async () => {
    await webAuthRequest("/phone-number/reset-password", { phoneNumber: phone.trim(), otp: otp.trim(), newPassword });
    setMode("login");
    setIdentifier(phone.trim());
    setPhone("");
    setOtp("");
    setNewPassword("");
    setRecoveryReady(false);
    setSuccess("密码已更新，请使用账号名或手机号重新登录。");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    resetNotice();
    setLoading(true);
    try {
      if (mode === "login") await submitLogin();
      else if (mode === "register") await submitRegister();
      else if (recoveryReady) await completeRecovery();
      else await requestRecoveryCode();
    } catch (failure) {
      setError(authMessage(failure));
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);
    try { await webAuthRequest("/sign-out", {}); } catch { /* ignore */ }
    setAccount(null);
    setExpiresAt(undefined);
    setIdentity(undefined);
    setAccountClosed(false);
    setLoading(false);
    setSuccess("已退出当前会话。");
  };

  const cancelAccount = async () => {
    if (!window.confirm("注销会撤销当前会话并匿名化普通资料。仍有未完成事项时，服务端会阻止本次操作。继续吗？")) return;
    resetNotice();
    setCancelLoading(true);
    try {
      const result = await webAuthRequest<CancellationResponse>("/account/cancel", { reason: "用户在账户页提交注销" });
      setAccount({ name: "账号已注销" });
      setExpiresAt(undefined);
      setAccountClosed(true);
      setIdentity({
        accountStatus: result.status,
        identityStatus: "UNVERIFIED",
        ageStatus: "UNKNOWN",
        provider: "none",
        eligibleForProtectedTrade: false,
      });
      setSuccess("账号已注销，必要历史关联保留；当前会话已撤销。");
    } catch (failure) {
      if (failure instanceof WebAuthError) setError(cancellationFailureMessage(failure.status, failure.code));
      else setError("注销未完成，请稍后重试。");
    } finally {
      setCancelLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-canvas)] text-[var(--color-text-primary)] flex flex-col justify-between p-4 sm:p-8">
      <header className="flex items-center justify-between pb-6 border-b border-[var(--color-border-subtle)] max-w-4xl mx-auto w-full">
        <a href="/" className="flex items-center gap-2">
          <BrandLogo height={32} showText />
        </a>
        <a href="/" className="text-xs text-[var(--color-accent-brand)] hover:underline font-semibold">
          ← 返回门户首页
        </a>
      </header>

      <main className="max-w-md mx-auto w-full my-8 bg-[var(--color-bg-card)] p-6 sm:p-8 rounded-2xl border border-[var(--color-border-default)] shadow-xl">
        {account ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold tracking-widest text-[var(--color-accent-brand)] uppercase">
                  MEMBER SESSION
                </span>
                <h1 className="text-xl font-bold mt-1">
                  {accountClosed ? "账号已注销" : `欢迎回来，${account.name || account.username || "用户"}`}
                </h1>
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={loading || cancelLoading}
                className="rounded-lg border border-[var(--color-border-default)] px-3 py-1 text-xs font-medium hover:bg-[var(--color-bg-elevated)] transition-colors"
              >
                退出
              </button>
            </div>

            <div className="rounded-xl bg-[var(--color-bg-elevated)] p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">账号名</span>
                <span className="font-semibold">{account.username || "未提供"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">邮箱</span>
                <span className="font-semibold">{account.email || "未提供"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">状态</span>
                <span className="font-semibold">
                  {identity ? accountStatusLabel(identity.accountStatus) : "读取中…"}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-[var(--color-text-muted)]">
              {expiryText(expiresAt)}
            </p>

            <Status error={error} success={success} />

            {!accountClosed && (
              <button
                type="button"
                onClick={() => void cancelAccount()}
                disabled={cancelLoading}
                className="w-full rounded-xl border border-red-500/40 py-2.5 text-xs font-bold text-red-400 hover:bg-red-500/10 transition-colors"
              >
                {cancelLoading ? "正在提交…" : "注销账号"}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <span className="text-[10px] font-bold tracking-widest text-[var(--color-accent-brand)] uppercase">
                ACCOUNT ACCESS
              </span>
              <h2 className="text-xl font-bold mt-1">
                {mode === "login" ? "登录洲洲商行" : mode === "register" ? "创建您的账号" : "找回账号密码"}
              </h2>
            </div>

            <nav className="flex gap-2 border-b border-[var(--color-border-subtle)] pb-2 text-xs">
              <button
                type="button"
                onClick={() => chooseMode("login")}
                className={`pb-1 font-semibold ${
                  mode === "login"
                    ? "text-[var(--color-accent-brand)] border-b-2 border-[var(--color-accent-brand)]"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                登录
              </button>
              <button
                type="button"
                onClick={() => chooseMode("register")}
                className={`pb-1 font-semibold ${
                  mode === "register"
                    ? "text-[var(--color-accent-brand)] border-b-2 border-[var(--color-accent-brand)]"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                注册
              </button>
              <button
                type="button"
                onClick={() => chooseMode("recover")}
                className={`pb-1 font-semibold ${
                  mode === "recover"
                    ? "text-[var(--color-accent-brand)] border-b-2 border-[var(--color-accent-brand)]"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                找回密码
              </button>
            </nav>

            <form onSubmit={submit} className="space-y-4">
              {mode === "login" && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                      账号名或手机号
                    </label>
                    <input
                      autoFocus
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="username 或 +86…"
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                      密码
                    </label>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={12}
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                </>
              )}

              {mode === "register" && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">邮箱</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">显示名称</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">账号名</label>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">密码</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={12}
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                </>
              )}

              {mode === "recover" && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-[var(--color-text-secondary)]">已验证手机号</label>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+8613800000000"
                      required
                      className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                    />
                  </div>
                  {recoveryReady && (
                    <>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-[var(--color-text-secondary)]">短信验证码</label>
                        <input
                          inputMode="numeric"
                          value={otp}
                          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          required
                          className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-[var(--color-text-secondary)]">新密码</label>
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          minLength={12}
                          required
                          className="w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs focus:border-[var(--color-accent-brand)] focus-visible:outline-none"
                        />
                      </div>
                    </>
                  )}
                </>
              )}

              <Status error={error} success={success} />

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-[var(--color-accent-brand)] py-2.5 text-xs font-bold text-[var(--color-accent-brand-text)] hover:bg-[var(--color-accent-brand-hover)] transition-colors shadow-sm"
              >
                {loading
                  ? "处理中…"
                  : mode === "login"
                  ? "继续登录"
                  : mode === "register"
                  ? "创建账号"
                  : recoveryReady
                  ? "更新密码"
                  : "发送验证码"}
              </button>
            </form>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-[var(--color-text-muted)] py-4">
        洲洲商行 · 认证与会话服务端统一保护 · 本地开发环境
      </footer>
    </div>
  );
}
