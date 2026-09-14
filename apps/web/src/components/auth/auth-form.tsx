"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { publishUserSessionChange, useUserSession } from "@/components/session/user-session-provider";

type Mode = "login" | "register" | "recover";
type AuthOperation = "login" | "register" | "send-otp";
type LoginKind = "auto" | "phone" | "username";

export class WebAuthError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export async function webAuthRequest<T>(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/auth/user" + path, {
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

function authMessage(error: unknown, operation: AuthOperation): string {
  if (!(error instanceof WebAuthError)) return "服务暂时不可用，请稍后重试。";
  if (error.code === "NETWORK_ERROR") {
    return operation === "register" ? "注册请求结果待确认，请不要重复提交验证码，改用该手机号登录。" : "服务暂时不可用，请稍后重试。";
  }
  if (operation === "send-otp" && (error.code === "NOT_IMPLEMENTED" || error.status === 501)) return "短信服务尚未接入，当前环境不能完成手机号注册。";
  if (operation === "send-otp" && error.status === 503) return "短信发送服务当前不可用，请稍后重试。";
  if (error.code === "SESSION_NOT_CONFIRMED") return operation === "register" ? "注册结果待确认，请不要重复提交验证码，改用该手机号登录。" : "登录服务已响应，但会话仍待确认，请重试。";
  if (error.code === "UNAUTHENTICATED") return "账号名、手机号或密码不正确。";
  if (error.code === "CONFLICT") return operation === "login" ? "该标识同时对应手机号和账号名，请使用唯一的账号名或手机号。" : "该手机号已注册，请切换到登录。";
  if (error.code === "RATE_LIMITED" || error.code === "TOO_MANY_REQUESTS" || error.status === 429) return "尝试次数过多，请稍后再试。";
  if (error.code === "INVALID_ARGUMENT" || error.code === "BAD_REQUEST" || (error.status >= 400 && error.status < 500)) {
    return operation === "login" ? "账号名、手机号或密码不正确。" : "请检查手机号、验证码和密码格式。";
  }
  if (error.status >= 500) return operation === "register" ? "注册服务异常，注册结果可能需要确认。" : operation === "login" ? "登录服务暂时不可用，请稍后重试。" : "服务暂时不可用，请稍后重试。";
  return "请求未完成，请稍后重试。";
}

function compactPhone(value: string): string {
  return value.trim().replace(/[\s-]/g, "");
}

type RequestState = { id: number; controller: AbortController };

export function AuthForm({ next, onSuccess, autoFocus = true }: { next?: string; onSuccess?: () => void | Promise<void>; autoFocus?: boolean }) {
  const session = useUserSession();
  const [mode, setMode] = useState<Mode>("login");
  const [loginKind, setLoginKind] = useState<LoginKind>("auto");
  const [identifier, setIdentifier] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentFor, setSentFor] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [registrationPending, setRegistrationPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const requestSeq = useRef(0);
  const requestRef = useRef<RequestState | null>(null);

  useEffect(() => () => {
    requestSeq.current += 1;
    requestRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    if (!requestRef.current) return;
    requestSeq.current += 1;
    requestRef.current.controller.abort();
    requestRef.current = null;
    setBusy(false);
    setSending(false);
  }, [next]);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const beginRequest = (): RequestState => {
    requestRef.current?.controller.abort();
    const request = { id: ++requestSeq.current, controller: new AbortController() };
    requestRef.current = request;
    return request;
  };

  const isCurrent = (request: RequestState): boolean => requestRef.current?.id === request.id && requestSeq.current === request.id;

  const chooseMode = (nextMode: Mode) => {
    if (busy) return;
    if (nextMode === "login" && registrationPending) {
      setIdentifier(registrationPending);
      setRegistrationPending(undefined);
      setPassword("");
      setSuccess("注册结果待确认，请使用注册时的密码登录；成功后将确认服务端会话。");
    } else {
      setSuccess(undefined);
    }
    setError(undefined);
    setMode(nextMode);
  };

  const confirmSession = async (request: RequestState, message: string) => {
    const status = await session.confirm();
    if (!isCurrent(request)) return;
    if (status !== "authenticated") throw new WebAuthError(status === "error" ? 503 : 500, "SESSION_NOT_CONFIRMED");
    setPassword("");
    setSuccess(message);
    publishUserSessionChange();
    await onSuccess?.();
  };

  const sendOtp = async () => {
    const target = compactPhone(phone);
    if (!target) {
      setError("请先填写手机号。");
      return;
    }
    if (target !== sentFor && Date.now() < cooldownUntil) return;
    setError(undefined);
    setSuccess(undefined);
    const request = beginRequest();
    setSending(true);
    try {
      await webAuthRequest<{ status: true }>("/phone-registration/send-otp", { phoneNumber: target }, request.controller.signal);
      if (!isCurrent(request)) return;
      setSentFor(target);
      setCooldownUntil(Date.now() + 60_000);
      setNow(Date.now());
      setSuccess("验证码已发送，请在 5 分钟内完成注册。");
    } catch (failure) {
      if (isCurrent(request)) setError(authMessage(failure, "send-otp"));
    } finally {
      if (isCurrent(request)) setSending(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const submitMode = mode;
    const submitLoginKind = loginKind;
    const submitPhone = compactPhone(phone);
    const submitIdentifier = identifier.trim();
    const submitPassword = password;
    const submitCode = code.trim();
    const request = beginRequest();
    setError(undefined);
    setSuccess(undefined);
    setBusy(true);
    try {
      if (submitMode === "login") {
        await webAuthRequest<{ user?: { id?: string } }>("/sign-in/identifier", { identifier: submitIdentifier, password: submitPassword, kind: submitLoginKind === "auto" ? undefined : submitLoginKind }, request.controller.signal);
        await confirmSession(request, "登录成功，服务端会话已建立。");
      } else if (submitMode === "register") {
        if (registrationPending) throw new WebAuthError(409, "REGISTRATION_PENDING");
        if (submitPhone !== sentFor) throw new WebAuthError(400, "INVALID_ARGUMENT");
        await webAuthRequest<{ status: true }>("/phone-registration/complete", { phoneNumber: submitPhone, code: submitCode, password: submitPassword, acceptedTerms }, request.controller.signal);
        await confirmSession(request, "账号已创建并登录。");
      }
    } catch (failure) {
      if (!isCurrent(request)) return;
      const unknownRegistrationResult = submitMode === "register" && submitPhone && failure instanceof WebAuthError && (
        failure.status === 0 || failure.status >= 500 || failure.code === "SESSION_NOT_CONFIRMED"
      );
      if (unknownRegistrationResult) {
        setRegistrationPending(submitPhone);
        setError("注册结果待确认：账号可能已经创建。请不要重复提交验证码，改用该手机号登录以恢复会话。");
      } else if (failure instanceof WebAuthError && failure.code === "REGISTRATION_PENDING") {
        setError("注册结果待确认，请改用该手机号登录。");
      } else {
        setError(authMessage(failure, submitMode === "register" ? "register" : "login"));
      }
    } finally {
      if (isCurrent(request)) setBusy(false);
    }
  };

  const recoverRegistration = () => {
    if (!registrationPending || busy) return;
    const pendingPhone = registrationPending;
    setMode("login");
    setIdentifier(pendingPhone);
    setPhone("");
    setCode("");
    setPassword("");
    setAcceptedTerms(false);
    setRegistrationPending(undefined);
    setError(undefined);
    setSuccess("注册结果待确认，请使用注册时的密码登录；成功后将确认服务端会话。");
  };

  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const title = mode === "login" ? "登录洲洲商行" : mode === "register" ? "创建手机号账号" : "找回账号密码";

  return <div className="auth-form" data-auth-form-next={next ?? ""}>
    <div className="auth-form-heading"><h2>{title}</h2><p>{mode === "login" ? "使用手机号或原账号名登录。" : mode === "register" ? "手机号验证只证明号码控制权，不代表实名、年龄或交易资格。" : "当前环境尚未接入真实短信找回。"}</p></div>
    {registrationPending ? <div className="auth-recovery" role="alert"><p>注册结果待确认。不要重复提交已消费的验证码。</p><button type="button" className="button secondary" onClick={recoverRegistration}>使用该手机号尝试登录</button></div> : null}
    <div className="auth-tabs" role="tablist" aria-label="认证方式">
      <button type="button" role="tab" aria-selected={mode === "login"} disabled={busy} onClick={() => chooseMode("login")}>登录</button>
      <button type="button" role="tab" aria-selected={mode === "register"} disabled={busy} onClick={() => chooseMode("register")}>注册</button>
      <button type="button" role="tab" aria-selected={mode === "recover"} disabled={busy} onClick={() => chooseMode("recover")}>找回密码</button>
    </div>

    {mode === "recover" ? <>
      <p className="auth-muted" role="status">短信找回需要真实短信服务。当前没有开放假验证码或测试码入口，请联系平台客服。</p>
      <button type="button" className="button primary auth-submit" disabled>短信找回暂不可用</button>
    </> : <form onSubmit={submit} className="auth-fields">
      {mode === "login" ? <><div className="auth-login-kind" role="group" aria-label="登录标识类型"><button type="button" className={loginKind === "auto" ? "is-selected" : ""} disabled={busy} onClick={() => setLoginKind("auto")}>自动识别</button><button type="button" className={loginKind === "phone" ? "is-selected" : ""} disabled={busy} onClick={() => setLoginKind("phone")}>手机号</button><button type="button" className={loginKind === "username" ? "is-selected" : ""} disabled={busy} onClick={() => setLoginKind("username")}>账号名</button></div><label>{loginKind === "phone" ? "手机号" : loginKind === "username" ? "账号名" : "账号名或手机号"}<input autoFocus={autoFocus} type={loginKind === "phone" ? "tel" : "text"} inputMode={loginKind === "phone" ? "numeric" : undefined} value={identifier} disabled={busy} onChange={(event) => setIdentifier(event.target.value)} placeholder={loginKind === "phone" ? "11 位大陆手机号" : loginKind === "username" ? "原账号名" : "手机号或原账号名"} autoComplete={loginKind === "phone" ? "tel" : "username"} required /></label></> : <>
        <label>手机号<input autoFocus={autoFocus} type="tel" inputMode="numeric" value={phone} disabled={busy || sending || Boolean(registrationPending)} onChange={(event) => { setPhone(event.target.value); setSentFor(""); setRegistrationPending(undefined); }} placeholder="11 位大陆手机号" autoComplete="tel" required /></label>
        <div className="auth-code-field"><label htmlFor="phone-registration-code">短信验证码</label><div className="auth-code-row"><input id="phone-registration-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy || Boolean(registrationPending)} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位验证码" required /><button type="button" className="button secondary" disabled={sending || busy || remaining > 0 || Boolean(registrationPending)} onClick={() => void sendOtp()}>{sending ? "发送中…" : remaining > 0 ? remaining + "s 后重发" : "获取验证码"}</button></div></div>
      </>}
      <label>密码<div className="auth-password-row"><input type={showPassword ? "text" : "password"} disabled={busy} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 12 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "register" ? "至少 12 位" : "请输入现有密码"} required /><button type="button" className="auth-password-toggle" disabled={busy} onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? "隐藏" : "显示"}</button></div></label>
      {mode === "register" ? <label className="auth-consent"><input type="checkbox" checked={acceptedTerms} disabled={busy || Boolean(registrationPending)} onChange={(event) => setAcceptedTerms(event.target.checked)} required /><span>我已阅读并同意 <a href="/help#publish-guide">平台规则</a>，并了解 <a href="/help#protection">未成年人保护说明</a>。</span></label> : null}
      {error || success ? <p className={"auth-status " + (error ? "is-error" : "is-success")} role={error ? "alert" : "status"}>{error ?? success}</p> : null}
      <button type="submit" className="button primary auth-submit" disabled={busy || Boolean(registrationPending)}>{busy ? "处理中…" : mode === "login" ? "继续登录" : "创建账号"}</button>
    </form>}
  </div>;
}
