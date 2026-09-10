"use client";

import { useEffect, useState, type FormEvent } from "react";

type Mode = "login" | "register" | "recover";
type Account = { name?: string; email?: string; username?: string };
type SessionResponse = { user?: Account; session?: { expiresAt?: string } } | null;

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

function Brand() {
  return <div className="web-brand"><span className="web-brand-mark" aria-hidden="true">洲</span><span><strong>洲洲商行</strong><small>ACCOUNT ACCESS</small></span></div>;
}

function Status({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return <p className={`web-status ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}>{error ?? success}</p>;
}

export default function Home() {
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

  useEffect(() => {
    void webAuthRequest<SessionResponse>("/get-session").then((session) => {
      setAccount(session?.user ?? null);
      setExpiresAt(session?.session?.expiresAt);
    }).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  const resetNotice = () => { setError(undefined); setSuccess(undefined); };
  const chooseMode = (next: Mode) => { resetNotice(); setMode(next); if (next !== "recover") setRecoveryReady(false); };

  const submitLogin = async () => {
    const value = identifier.trim();
    const result = value.startsWith("+")
      ? await webAuthRequest<{ user?: Account; session?: { expiresAt?: string } }>("/sign-in/phone-number", { phoneNumber: value, password })
      : await webAuthRequest<{ user?: Account; session?: { expiresAt?: string } }>("/sign-in/username", { username: value, password });
    setAccount(result.user ?? null);
    setExpiresAt(result.session?.expiresAt);
    setPassword("");
    setSuccess("登录成功，服务端会话已建立。");
  };

  const submitRegister = async () => {
    const result = await webAuthRequest<{ user?: Account; session?: { expiresAt?: string } }>("/sign-up/email", { email: email.trim(), name: name.trim(), username: username.trim(), password });
    setAccount(result.user ?? null);
    setExpiresAt(result.session?.expiresAt);
    setPassword("");
    setSuccess("账号已创建并登录。");
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
    try { await webAuthRequest("/sign-out", {}); } catch { /* local view still exits if the session already expired */ }
    setAccount(null);
    setExpiresAt(undefined);
    setLoading(false);
    setSuccess("已退出当前会话。");
  };

  if (loading && !account && mode === "login" && !identifier && !password) return <main className="web-loading"><Brand /><p>正在读取账号状态…</p></main>;
  if (account) return <main className="web-member"><header><Brand /><button className="quiet-button" type="button" onClick={() => void signOut()} disabled={loading}>退出</button></header><section className="member-card"><p className="eyebrow">MEMBER SESSION</p><h1>欢迎回来，{account.name || account.username || "用户"}。</h1><p className="member-copy">你的身份会话由服务端维护。商品目录和交易数据将在业务范围确认后开放。</p><div className="member-facts"><div><span>账号名</span><strong>{account.username || "未提供"}</strong></div><div><span>邮箱</span><strong>{account.email || "未提供"}</strong></div><div><span>状态</span><strong>会话正常</strong></div></div><p className="member-note">{expiryText(expiresAt)} · 当前为隔离开发环境，不连接真实支付或客服渠道。</p><Status error={error} success={success} /></section></main>;

  return <main className="web-shell"><section className="web-intro"><Brand /><div className="intro-copy"><p className="eyebrow">MEMBER ACCESS / LOCAL</p><h1>先确认身份，<br />再开始探索。</h1><p>洲洲商行的新用户入口。账号、手机号和会话都由服务端统一保护。</p></div><footer>开发环境 · 不连接真实支付、短信或网易云信</footer></section><section className="web-auth"><div className="auth-topline"><span>安全入口</span><span className="status-dot">隔离环境</span></div><div className="auth-card"><div className="auth-heading"><p className="eyebrow">ACCOUNT ACCESS</p><h2>{mode === "login" ? "欢迎回来。" : mode === "register" ? "创建你的账号。" : "找回账号。"}</h2><p>{mode === "login" ? "使用账号名或手机号继续。" : mode === "register" ? "注册后即可建立受保护的用户会话。" : "通过已验证手机号重设密码。"}</p></div><nav className="auth-tabs" aria-label="账号入口"><button className={mode === "login" ? "is-active" : ""} type="button" onClick={() => chooseMode("login")}>登录</button><button className={mode === "register" ? "is-active" : ""} type="button" onClick={() => chooseMode("register")}>注册</button><button className={mode === "recover" ? "is-active" : ""} type="button" onClick={() => chooseMode("recover")}>找回密码</button></nav><form className="web-form" onSubmit={submit} noValidate>{mode === "login" && <><label><span>账号名或手机号</span><input autoFocus value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="username 或 +86…" required /></label><label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label></>}{mode === "register" && <><label><span>邮箱</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label><span>显示名称</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label><label><span>账号名</span><input value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label><span>密码</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label></>}{mode === "recover" && <><label><span>已验证手机号</span><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8613800000000" required /></label>{recoveryReady && <><label><span>短信验证码</span><input inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} required /></label><label><span>新密码</span><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} required /></label></>}</>}<Status error={error} success={success} /><button className="submit-button" type="submit" disabled={loading}>{loading ? "处理中…" : mode === "login" ? "继续登录" : mode === "register" ? "创建账号" : recoveryReady ? "更新密码" : "发送验证码"}</button></form><p className="auth-footnote">服务端会话 · 统一错误语义 · 不保存浏览器中的密码</p></div></section></main>;
}
