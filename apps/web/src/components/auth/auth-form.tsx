"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { publishUserSessionChange, useUserSession } from "@/components/session/user-session-provider";

type Mode = "login" | "register" | "recover";
type AuthOperation = "login" | "register" | "send-otp";
type LoginKind = "phone" | "username" | "sms";
type FieldKey = "identifier" | "phone" | "code" | "password" | "terms";
type FieldErrors = Partial<Record<FieldKey, string>>;

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
    return operation === "register" ? "注册结果暂时无法确认，请稍后用刚设置的密码尝试登录。" : "服务暂时不可用，请稍后重试。";
  }
  if (operation === "send-otp" && (error.code === "NOT_IMPLEMENTED" || error.status === 501)) return "短信服务暂未开放，当前不能使用验证码登录或注册。";
  if (operation === "send-otp" && error.status === 503) return "短信发送服务当前不可用，请稍后重试。";
  if (error.code === "SESSION_NOT_CONFIRMED") return operation === "register" ? "暂未确认注册结果，请稍后用刚设置的密码尝试登录。" : "暂未确认登录结果，请重试。";
  if (error.code === "UNAUTHENTICATED") return "账号名、手机号或密码不正确。";
  if (error.code === "CONFLICT") return operation === "login" ? "该标识同时对应手机号和账号名，请选择明确的登录方式。" : "该手机号已注册，请使用原密码登录。";
  if (error.code === "RATE_LIMITED" || error.code === "TOO_MANY_REQUESTS" || error.status === 429) return "尝试次数过多，请稍后再试。";
  if (error.code === "INVALID_ARGUMENT" || error.code === "BAD_REQUEST" || (error.status >= 400 && error.status < 500)) {
    return operation === "login" ? "账号名、手机号或密码不正确。" : "请检查手机号、验证码和密码格式。";
  }
  if (error.status >= 500) return operation === "register" ? "注册服务暂时异常，结果可能需要确认。" : operation === "login" ? "登录服务暂时不可用，请稍后重试。" : "服务暂时不可用，请稍后重试。";
  return "请求未完成，请稍后重试。";
}

function compactPhone(value: string): string {
  const compact = value.trim().replace(/[\s-]/g, "");
  return compact.startsWith("+86") ? compact.slice(3) : compact.startsWith("0086") ? compact.slice(4) : compact;
}

function isMainlandPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value);
}

export function maskPhone(value: string): string {
  const digits = compactPhone(value).replace(/^\+86/, "");
  return isMainlandPhone(digits) ? digits.slice(0, 3) + "****" + digits.slice(-4) : "该手机号";
}

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? <span id={id} className="auth-field-error" role="alert">{text}</span> : null;
}

type RequestState = { id: number; controller: AbortController };
type AuthFormProps = { next?: string; contextLabel?: string; onSuccess?: () => void | Promise<void>; autoFocus?: boolean };

export function AuthForm({ next, contextLabel, onSuccess, autoFocus = true }: AuthFormProps) {
  const session = useUserSession();
  const [mode, setMode] = useState<Mode>("login");
  const [loginKind, setLoginKind] = useState<LoginKind>("sms");
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
  const [registeredPhone, setRegisteredPhone] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [inviteCode, setInviteCode] = useState("");
  const [policy, setPolicy] = useState<string>();
  useEffect(() => { const value = new URLSearchParams(window.location.search).get("inviteCode") ?? ""; if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) setInviteCode(value); }, []);
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
    if (cooldownUntil <= Date.now()) {
      setNow(Date.now());
      return;
    }
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const beginRequest = (): RequestState => {
    requestRef.current?.controller.abort();
    const request = { id: ++requestSeq.current, controller: new AbortController() };
    requestRef.current = request;
    return request;
  };

  const isCurrent = (request: RequestState): boolean => requestRef.current?.id === request.id && requestSeq.current === request.id;

  const setField = (key: FieldKey, value: string) => {
    setFieldErrors((previous) => ({ ...previous, [key]: value || undefined }));
  };

  const goToLogin = (phoneToUse?: string) => {
    if (busy || sending) return;
    const pendingPhone = phoneToUse ?? registrationPending ?? registeredPhone;
    setMode("login");
    setLoginKind("phone");
    if (pendingPhone) setIdentifier(pendingPhone);
    setPhone("");
    setSentFor("");
    setCode("");
    setPassword("");
    setAcceptedTerms(false);
    setRegistrationPending(undefined);
    setRegisteredPhone(undefined);
    setFieldErrors({});
    setError(undefined);
    setSuccess(pendingPhone ? "手机号已带入，请使用原密码登录。" : undefined);
  };

  const chooseMode = (nextMode: Mode) => {
    if (busy || sending) return;
    if (nextMode === "login") {
      goToLogin();
      return;
    }
    setMode(nextMode);
    setCode(""); setSentFor(""); setPassword(""); setAcceptedTerms(false);
    setFieldErrors({});
    setError(undefined);
    setSuccess(undefined);
  };

  const confirmSession = async (request: RequestState, message: string) => {
    if (!isCurrent(request)) return;
    const status = await session.confirm();
    if (!isCurrent(request)) return;
    if (status !== "authenticated") throw new WebAuthError(status === "error" ? 503 : 500, "SESSION_NOT_CONFIRMED");
    setPassword("");
    setSuccess(message);
    publishUserSessionChange();
    await onSuccess?.();
  };

  const sendOtp = async () => {
    if (busy || sending) return;
    if (!acceptedTerms) { setField("terms", "请先阅读并同意平台服务协议与用户隐私政策。"); return; }
    const target = compactPhone(mode === "login" ? identifier : phone);
    if (!isMainlandPhone(target)) {
      setField(mode === "login" ? "identifier" : "phone", "请输入有效的大陆手机号。");
      setError(undefined);
      return;
    }
    if (Date.now() < cooldownUntil) return;
    setFieldErrors({});
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
      setSuccess("验证码已发送至 " + maskPhone(target) + "，请及时填写。");
    } catch (failure) {
      if (isCurrent(request)) setError(authMessage(failure, "send-otp"));
    } finally {
      if (isCurrent(request)) setSending(false);
    }
  };

  const validate = (submitMode: Mode, submitLoginKind: LoginKind, submitIdentifier: string, submitPhone: string, submitCode: string, submitPassword: string): FieldErrors => {
    const nextErrors: FieldErrors = {};
    if (!acceptedTerms) nextErrors.terms = "请先阅读并同意平台服务协议与用户隐私政策。";
    if (submitMode === "login") {
      if (!submitIdentifier) nextErrors.identifier = submitLoginKind !== "username" ? "请输入手机号。" : "请输入账号名。";
      else if (submitLoginKind !== "username" && !isMainlandPhone(compactPhone(submitIdentifier))) nextErrors.identifier = "请输入有效的大陆手机号。";
      if (submitLoginKind === "sms") {
        if (!/^\d{6}$/.test(submitCode)) nextErrors.code = "请输入 6 位数字验证码。";
        else if (compactPhone(submitIdentifier) !== sentFor) nextErrors.code = "请先获取该手机号的验证码。";
      } else if (!submitPassword) nextErrors.password = "请输入密码。";
    } else if (submitMode === "register") {
      if (!submitPhone) nextErrors.phone = "请输入手机号。";
      else if (!isMainlandPhone(submitPhone)) nextErrors.phone = "请输入有效的大陆手机号。";
      if (!/^\d{6}$/.test(submitCode)) nextErrors.code = "请输入 6 位数字验证码。";
      else if (submitPhone !== sentFor) nextErrors.code = "请先获取该手机号的验证码。";
      if (!submitPassword) nextErrors.password = "请设置密码。";
      else if (submitPassword.length < 12) nextErrors.password = "注册密码至少需要 12 位。";
      if (!acceptedTerms) nextErrors.terms = "请先阅读并同意平台服务协议与用户隐私政策。";
    }
    return nextErrors;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || sending) return;
    const submitMode = mode;
    const submitLoginKind = loginKind;
    const submitPhone = compactPhone(phone);
    const submitIdentifier = submitLoginKind !== "username" ? compactPhone(identifier) : identifier.trim();
    const submitPassword = password;
    const submitCode = code.trim();
    const nextErrors = validate(submitMode, submitLoginKind, submitIdentifier, submitPhone, submitCode, submitPassword);
    setFieldErrors(nextErrors);
    setError(undefined);
    setSuccess(undefined);
    if (Object.keys(nextErrors).length > 0) return;
    const request = beginRequest();
    setBusy(true);
    try {
      if (submitMode === "login") {
        if (submitLoginKind === "sms") {
          const result = await webAuthRequest<{ requiresPassword?: boolean }>("/phone-registration/complete", { phoneNumber: submitIdentifier, code: submitCode, acceptedTerms, loginOrRegister: true }, request.controller.signal);
          if (!isCurrent(request)) return;
          if (result.requiresPassword) {
            setPhone(submitIdentifier); setMode("register"); setPassword("");
            return;
          }
        } else {
          await webAuthRequest("/sign-in/identifier", { identifier: submitIdentifier, password: submitPassword, kind: submitLoginKind }, request.controller.signal);
        }
        await confirmSession(request, "登录成功。");
      } else if (submitMode === "register") {
        if (registrationPending) throw new WebAuthError(409, "REGISTRATION_PENDING");
        if (submitPhone !== sentFor) throw new WebAuthError(400, "INVALID_ARGUMENT");
        await webAuthRequest<{ status: true }>("/phone-registration/complete", { phoneNumber: submitPhone, code: submitCode, password: submitPassword, acceptedTerms, loginOrRegister: true }, request.controller.signal);
        await confirmSession(request, "账号已创建。");
      }
    } catch (failure) {
      if (!isCurrent(request)) return;
      const unknownRegistrationResult = submitMode === "register" && submitPhone && failure instanceof WebAuthError && (
        failure.status === 0 || failure.status >= 500 || failure.code === "SESSION_NOT_CONFIRMED"
      );
      if (unknownRegistrationResult) {
        setRegistrationPending(submitPhone);
        setError("注册结果暂时无法确认，请稍后用刚设置的密码尝试登录。");
      } else if (failure instanceof WebAuthError && failure.code === "REGISTRATION_PENDING") {
        setError("注册结果暂时无法确认，请稍后用刚设置的密码尝试登录。");
      } else {
        if (submitMode === "register" && failure instanceof WebAuthError && failure.status === 409 && failure.code === "CONFLICT") setRegisteredPhone(submitPhone);
        setError(authMessage(failure, submitMode === "register" ? "register" : "login"));
      }
    } finally {
      if (isCurrent(request)) setBusy(false);
    }
  };

  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const currentPhone = compactPhone(mode === "login" ? identifier : phone);
  const cooldownActive = remaining > 0;
  const codeSentForCurrent = currentPhone.length > 0 && currentPhone === sentFor;
  const formBusy = busy || sending;
  const title = mode === "login" ? "登录洲洲商行" : mode === "register" ? "创建手机号账号" : "找回账号密码";

  return <section className="auth-form" data-mode={mode} data-auth-form-next={next ?? ""} aria-label="账户认证">
    <h2 className="sr-only">{title}</h2>
    {contextLabel && <p className="auth-context">{contextLabel}</p>}
    <div className="auth-methods" aria-label="登录注册方式">
      {(["sms", "phone"] as const).map(kind => <button type="button" key={kind} aria-pressed={mode === "login" && (kind === "phone" ? loginKind !== "sms" : loginKind === kind)} disabled={formBusy} onClick={() => { if (mode !== "login") goToLogin(); setLoginKind(kind); setCode(""); setPassword(""); setSentFor(""); setFieldErrors({}); setError(undefined); }}>{kind === "sms" ? "验证码登录" : "密码登录"}</button>)}

    </div>
    {registrationPending ? <div className="auth-recovery" role="alert"><p>注册结果待确认，请稍后用刚设置的密码尝试登录。</p><button type="button" className="button secondary" onClick={() => goToLogin()}>使用该手机号登录</button></div> : null}
    {registeredPhone ? <div className="auth-recovery" role="status"><p>该手机号已注册，请使用原密码登录。</p><button type="button" className="button secondary" onClick={() => goToLogin(registeredPhone)}>使用该手机号登录</button></div> : null}

    {mode === "recover" ? <div className="auth-unavailable" role="status"><p>短信找回暂未开放，暂时不能通过短信找回密码。</p><p>请<a href="/help">查看帮助与规则</a>，了解当前可用的处理方式。</p></div> : <form onSubmit={submit} className="auth-fields" noValidate>
      {mode === "login" ? <div className="auth-login-stack">
        <div className="auth-field"><label className="auth-field-label sr-only" htmlFor="auth-identifier">{loginKind !== "username" ? "手机号" : "账号名"}</label><input key={loginKind} id="auth-identifier" name="identifier" autoFocus={autoFocus} type={loginKind !== "username" ? "tel" : "text"} inputMode={loginKind !== "username" ? "numeric" : undefined} value={identifier} disabled={formBusy} onChange={(event) => { setIdentifier(event.target.value); setCode(""); setField("identifier", ""); setError(undefined); }} placeholder={loginKind !== "username" ? "大陆手机号" : "原账号名"} autoComplete={loginKind !== "username" ? "tel" : "username"} aria-invalid={Boolean(fieldErrors.identifier)} aria-describedby={fieldErrors.identifier ? "auth-identifier-error" : undefined} /><FieldError id="auth-identifier-error" text={fieldErrors.identifier} /></div>

      </div> : <p className="auth-context">手机号 {maskPhone(phone)} 已验证，设置密码即可完成注册。</p>}
      {mode === "login" && loginKind === "sms" && <>
        <div className="auth-code-field"><label className="auth-field-label sr-only" htmlFor="phone-registration-code">短信验证码</label><div className="auth-code-row"><input id="phone-registration-code" name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={formBusy || Boolean(registrationPending)} onChange={(event) => { setCode(event.target.value.replace(/\D/g, "")); setField("code", ""); setError(undefined); }} placeholder="6 位验证码" aria-invalid={Boolean(fieldErrors.code)} aria-describedby={fieldErrors.code ? "auth-code-error" : codeSentForCurrent ? "auth-code-help" : undefined} /><button type="button" className="button secondary" disabled={formBusy || cooldownActive || Boolean(registrationPending)} onClick={() => void sendOtp()}>{sending ? "发送中…" : cooldownActive ? remaining + "s 后重发" : "获取验证码"}</button></div>{codeSentForCurrent ? <p id="auth-code-help" className="auth-field-help" role="status">验证码已发送至 {maskPhone(sentFor)}，请及时填写。</p> : null}<FieldError id="auth-code-error" text={fieldErrors.code} /></div>
      </>}
      {mode === "login" && loginKind === "sms" && <p className="auth-field-help">未注册手机号验证后，将在此完成注册。</p>}
      {mode === "register" && <div className="auth-field"><label className="auth-field-label sr-only" htmlFor="auth-invite">邀请码 <span>（选填）</span></label><input id="auth-invite" value={inviteCode} maxLength={64} disabled={formBusy} onChange={event => setInviteCode(event.target.value)} placeholder="邀请码（选填，可由邀请链接带入）" autoComplete="off" /><span className="auth-field-help">邀请码绑定尚未开放，本次注册不会绑定邀请关系。</span></div>}
      {(mode === "register" || loginKind !== "sms") && <div className="auth-field"><label className="auth-field-label sr-only" htmlFor="auth-password">密码</label><div className="auth-password-row"><input id="auth-password" name="password" type={showPassword ? "text" : "password"} disabled={formBusy} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 12 : undefined} value={password} onChange={(event) => { setPassword(event.target.value); setField("password", ""); setError(undefined); }} placeholder={mode === "register" ? "设置密码（至少 12 位）" : "请输入现有密码"} aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? "auth-password-error" : undefined} /><button type="button" className="auth-password-toggle" disabled={formBusy} onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword}>{showPassword ? "隐藏" : "显示"}</button></div><FieldError id="auth-password-error" text={fieldErrors.password} /></div>}
      {mode === "login" && loginKind !== "sms" && <div className="auth-secondary-actions"><button type="button" className="auth-switch-link" disabled={formBusy} onClick={() => { setLoginKind(loginKind !== "username" ? "username" : "phone"); setCode(""); setPassword(""); setFieldErrors({}); setError(undefined); setSuccess(undefined); }}>使用{loginKind !== "username" ? "账号名" : "手机号"}登录</button><button type="button" disabled={formBusy} onClick={() => chooseMode("recover")}>忘记密码</button></div>}
      <button type="submit" className="button primary auth-submit" disabled={formBusy || Boolean(registrationPending) || Boolean(registeredPhone)} aria-busy={busy || undefined}>{busy ? mode === "login" ? "登录中…" : "创建中…" : mode === "login" ? (loginKind === "sms" ? "登录 / 注册" : "登录") : "完成注册并登录"}</button>
      {<div className="auth-consent"><input id="auth-terms" name="terms" type="checkbox" checked={acceptedTerms} disabled={formBusy || Boolean(registrationPending)} onChange={(event) => { setAcceptedTerms(event.target.checked); setField("terms", ""); }} aria-invalid={Boolean(fieldErrors.terms)} aria-describedby={fieldErrors.terms ? "auth-terms-error" : undefined} /><div><label htmlFor="auth-terms">我已阅读并同意</label><button type="button" onClick={() => setPolicy("平台服务协议")}>《平台服务协议》</button>和<button type="button" onClick={() => setPolicy("用户隐私政策")}>《用户隐私政策》</button><FieldError id="auth-terms-error" text={fieldErrors.terms} /></div></div>}

      {policy && <div className="auth-policy-notice" role="status"><strong>{policy}</strong><p>正式内容尚未提供，当前无法阅读或完成正式协议确认。</p><button type="button" onClick={() => setPolicy(undefined)}>收起说明</button></div>}
      {error || success ? <p className={"auth-status " + (error ? "is-error" : "is-success")} role={error ? "alert" : "status"}>{error ?? success}</p> : null}

    </form>}
  </section>;
}
