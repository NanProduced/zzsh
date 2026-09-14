"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import {
  publishUserSessionChange,
  useUserSession,
} from "@/components/session/user-session-provider";
import {
  accountStatusLabel,
  cancellationFailureMessage,
  type UserIdentitySnapshot,
} from "../user-account-status";
import { BrandLogo } from "@/components/brand/brand-logo";

type Mode = "login" | "register" | "recover";
type Account = { id?: string; name?: string; email?: string; username?: string };
type SessionResponse = { user?: Account; session?: { expiresAt?: string } } | null;
type CancellationResponse = { status: UserIdentitySnapshot["accountStatus"] };
type AccountDetails = {
  userId: string;
  account: Account;
  expiresAt?: string;
  identity: UserIdentitySnapshot;
};

class WebAuthError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function webAuthRequest<T>(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/auth/user${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
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
  const session = useUserSession();
  const returnRef = useRef<string | undefined>(undefined);
  // Tracks the identity the page is bound to, so late responses and private actions never
  // cross an identity switch.
  const currentUserIdRef = useRef<string | null>(null);
  currentUserIdRef.current = session.status === "authenticated" ? session.userId : null;
  const [mode, setMode] = useState<Mode>("login");
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [cancelLoading, setCancelLoading] = useState(false);

  // Private details are read only for the identity the shared session already confirmed. The
  // local read is aborted on identity switch, and a response for a different user is discarded.
  useEffect(() => {
    if (session.status !== "authenticated" || !session.userId) {
      setDetails(null);
      setDetailsLoading(false);
      setDetailsError(false);
      return;
    }
    const userId = session.userId;
    let active = true;
    const controller = new AbortController();
    setDetails(null);
    setDetailsLoading(true);
    setDetailsError(false);
    void (async () => {
      try {
        const current = await webAuthRequest<SessionResponse>("/get-session", undefined, controller.signal);
        const identityState = await webAuthRequest<UserIdentitySnapshot>("/identity/status", undefined, controller.signal);
        if (!active || controller.signal.aborted) return;
        if (current?.user?.id !== userId) return;
        setDetails({
          userId,
          account: current.user,
          expiresAt: current.session?.expiresAt,
          identity: identityState,
        });
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        if (failure instanceof WebAuthError && failure.status === 401) {
          session.revalidate();
          return;
        }
        setDetailsError(true);
      } finally {
        if (active && !controller.signal.aborted) setDetailsLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [session.status, session.userId, session.identityVersion]);

  useEffect(() => {
    returnRef.current = safeReturnTo(new URLSearchParams(window.location.search).get("next"));
  }, []);

  // Notices from the previous identity must not follow a real identity switch on this page.
  const previousUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentUserId = session.status === "authenticated" ? session.userId : null;
    if (!currentUserId) return;
    const previousUserId = previousUserIdRef.current;
    previousUserIdRef.current = currentUserId;
    if (previousUserId !== null && previousUserId !== currentUserId) {
      setError(undefined);
      setSuccess(undefined);
    }
  }, [session.status, session.userId]);

  const resetNotice = () => { setError(undefined); setSuccess(undefined); };
  const chooseMode = (next: Mode) => { resetNotice(); setMode(next); };

  const submitLogin = async () => {
    const value = identifier.trim();
    const result = value.startsWith("+")
      ? await webAuthRequest<{ user?: Account }>("/sign-in/phone-number", { phoneNumber: value, password })
      : await webAuthRequest<{ user?: Account }>("/sign-in/username", { username: value, password });
    if (!result.user) throw new WebAuthError(500, "INTERNAL_ERROR");
    setPassword("");
    setSuccess("登录成功，服务端会话已建立。");
    session.revalidate();
    publishUserSessionChange();
    if (returnRef.current) router.replace(returnRef.current);
  };

  const submitRegister = async () => {
    const result = await webAuthRequest<{ user?: Account }>("/sign-up/email", { email: email.trim(), name: name.trim(), username: username.trim(), password });
    if (!result.user) throw new WebAuthError(500, "INTERNAL_ERROR");
    setPassword("");
    setSuccess("账号已创建并登录。");
    session.revalidate();
    publishUserSessionChange();
    if (returnRef.current) router.replace(returnRef.current);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    resetNotice();
    setLoading(true);
    try {
      if (mode === "login") await submitLogin();
      else await submitRegister();
    } catch (failure) {
      setError(authMessage(failure));
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    resetNotice();
    try {
      await session.signOut();
      setSuccess("已退出当前会话。");
    } catch {
      setError("退出尚未确认：服务端仍返回登录状态，请重试。");
    }
  };

  const cancelAccount = async () => {
    if (!details || details.userId !== currentUserIdRef.current) return;
    if (!window.confirm("注销会撤销当前会话并匿名化普通资料。仍有未完成事项时，服务端会阻止本次操作。继续吗？")) return;
    resetNotice();
    const actingUserId = details.userId;
    setCancelLoading(true);
    try {
      await webAuthRequest<CancellationResponse>("/account/cancel", { reason: "用户在账户页提交注销" });
      if (currentUserIdRef.current !== actingUserId) return;
      setSuccess("账号已注销，必要历史关联保留；当前会话已撤销。");
      session.revalidate();
      publishUserSessionChange();
    } catch (failure) {
      if (currentUserIdRef.current !== actingUserId) return;
      if (failure instanceof WebAuthError) setError(cancellationFailureMessage(failure.status, failure.code));
      else setError("注销未完成，请稍后重试。");
    } finally {
      setCancelLoading(false);
    }
  };

  const accountView = session.status === "authenticated" && session.userId;

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
        {session.status === "loading" ? (
          <div className="space-y-3" role="status">
            <span className="text-[10px] font-bold tracking-widest text-[var(--color-accent-brand)] uppercase">
              MEMBER SESSION
            </span>
            <h1 className="text-xl font-bold">正在确认登录身份…</h1>
            <p className="text-xs text-[var(--color-text-secondary)]">确认完成前不会展示或操作任何账号资料。</p>
          </div>
        ) : session.status === "error" ? (
          <div className="space-y-3" role="alert">
            <span className="text-[10px] font-bold tracking-widest text-[var(--color-accent-brand)] uppercase">
              MEMBER SESSION
            </span>
            <h1 className="text-xl font-bold">暂时无法确认登录身份</h1>
            <p className="text-xs text-[var(--color-text-secondary)]">账号资料与操作已隐藏，不会按未登录处理。</p>
            <button
              type="button"
              onClick={session.revalidate}
              className="rounded-lg border border-[var(--color-border-default)] px-3 py-2 text-xs font-medium hover:bg-[var(--color-bg-elevated)] transition-colors"
            >
              重试身份确认
            </button>
          </div>
        ) : accountView ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold tracking-widest text-[var(--color-accent-brand)] uppercase">
                  MEMBER SESSION
                </span>
                <h1 className="text-xl font-bold mt-1">
                  {`欢迎回来，${authoritativeName(session.displayName, details?.account)}`}
                </h1>
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={cancelLoading}
                className="rounded-lg border border-[var(--color-border-default)] px-3 py-1 text-xs font-medium hover:bg-[var(--color-bg-elevated)] transition-colors"
              >
                退出
              </button>
            </div>

            {details ? (
              <>
                <div className="rounded-xl bg-[var(--color-bg-elevated)] p-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">账号名</span>
                    <span className="font-semibold">{details.account.username || "未提供"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">邮箱</span>
                    <span className="font-semibold">{details.account.email || "未提供"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-text-muted)]">状态</span>
                    <span className="font-semibold">{accountStatusLabel(details.identity.accountStatus)}</span>
                  </div>
                </div>

                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {expiryText(details.expiresAt)}；登录状态不代表实名、年龄或发布资格通过。
                </p>
              </>
            ) : detailsError ? (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 space-y-2 text-xs text-red-400" role="alert">
                <p>账号资料读取失败，已停止展示与操作。</p>
                <button
                  type="button"
                  onClick={session.revalidate}
                  className="rounded-lg border border-[var(--color-border-default)] px-3 py-1 font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated)] transition-colors"
                >
                  重新读取
                </button>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-secondary)]" role="status">
                {detailsLoading ? "正在读取账号资料…" : "账号资料未确认。"}
              </p>
            )}

            <Status error={error} success={success} />

            <button
              type="button"
              onClick={() => void cancelAccount()}
              disabled={cancelLoading || !details || details.userId !== session.userId}
              className="w-full rounded-xl border border-red-500/40 py-2.5 text-xs font-bold text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {cancelLoading ? "正在提交…" : "注销账号"}
            </button>
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
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    注册并登录不代表已完成实名、年龄或发布资格审核。
                  </p>
                </>
              )}

              {mode === "recover" && (
                <p
                  className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] p-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]"
                  role="status"
                >
                  当前环境尚未接入真实短信服务，暂不能通过手机号在线找回密码；接入后再开放该入口，需要协助可联系平台客服。
                </p>
              )}

              {mode !== "recover" && <Status error={error} success={success} />}

              {mode === "recover" ? (
                <button
                  type="button"
                  disabled
                  className="w-full rounded-xl bg-[var(--color-accent-brand)] py-2.5 text-xs font-bold text-[var(--color-accent-brand-text)] opacity-50"
                >
                  短信找回暂不可用
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-xl bg-[var(--color-accent-brand)] py-2.5 text-xs font-bold text-[var(--color-accent-brand-text)] hover:bg-[var(--color-accent-brand-hover)] transition-colors shadow-sm"
                >
                  {loading ? "处理中…" : mode === "login" ? "继续登录" : "创建账号"}
                </button>
              )}
            </form>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-[var(--color-text-muted)] py-4">
        洲洲商行 · 认证与会话由服务端统一保护
      </footer>
    </div>
  );
}

function authoritativeName(displayName: string | null, account: Account | undefined): string {
  return account?.name || account?.username || displayName || "用户";
}
