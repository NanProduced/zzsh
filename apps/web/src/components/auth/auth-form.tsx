"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { webAuthRequest, WebAuthError, authErrorMessage } from "@/lib/web-auth-request";
export { webAuthRequest, WebAuthError } from "@/lib/web-auth-request";

function compactPhone(value: string): string {
  const compact = value.trim().replace(/[\s-]/g, "");
  return compact.startsWith("+86") ? compact.slice(3) : compact.startsWith("0086") ? compact.slice(4) : compact;
}
export function maskPhone(value: string): string { const digits = compactPhone(value); return /^1[3-9]\d{9}$/.test(digits) ? digits.slice(0, 3) + "****" + digits.slice(-4) : "该手机号"; }
type Props = { next?: string; contextLabel?: string; inviteCode?: string; onSuccess?: () => void | Promise<void>; autoFocus?: boolean };

export function AuthForm({ next, contextLabel, inviteCode: initialInviteCode, onSuccess, autoFocus = true }: Props) {
  const session = useUserSession();
  const sessionStore = useUserSessionStore();
  const [mode, setMode] = useState<"login" | "recover">("login");
  const [method, setMethod] = useState<"sms" | "password">("sms");
  const [channel, setChannel] = useState<"phone" | "email">("phone");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [inviteCode, setInviteCode] = useState(initialInviteCode ?? "");
  const [challengeId, setChallengeId] = useState("");
  const [proofId, setProofId] = useState("");
  const [sentFor, setSentFor] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<"idle" | "accepted" | "unknown">("idle");
  const [guestConfirmed, setGuestConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [invalidField, setInvalidField] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [policy, setPolicy] = useState<string>();
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const writeLock = useRef(false);
  const loginSubject = useRef<{ phone: string; userId: string | null } | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => { if (invalidField && !busy && !sending) formRef.current?.querySelector<HTMLElement>("#" + invalidField)?.focus(); }, [invalidField, busy, sending]);
  useEffect(() => () => { generation.current++; abort.current?.abort(); }, []);
  useEffect(() => { generation.current++; abort.current?.abort(); setBusy(false); setSending(false); if (writeLock.current) { setOutcome("unknown"); setPassword(""); setCode(""); setConfirmation(""); } }, [next]);
  useEffect(() => { if (cooldownUntil <= Date.now()) return; const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, [cooldownUntil]);
  const begin = () => { abort.current?.abort(); const controller = new AbortController(); abort.current = controller; return { id: ++generation.current, controller }; };
  const current = (id: number) => generation.current === id;
  const normalized = () => mode === "recover" && channel === "email" ? contact.trim().toLowerCase() : compactPhone(contact);
  const validContact = () => mode === "recover" && channel === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized()) : /^1[3-9]\d{9}$/.test(normalized());
  const clearProof = () => { setCode(""); setPassword(""); setConfirmation(""); setChallengeId(""); setProofId(""); setSentFor(""); setError(undefined); setNotice(undefined); setInvalidField(undefined); };
  const validationError = (message: string, id: string) => { setError(message); setInvalidField(id); formRef.current?.querySelector<HTMLElement>("#" + id)?.focus(); };
  const changeMode = (value: "login" | "recover") => { if (busy || sending || outcome !== "idle") return; generation.current++; abort.current?.abort(); clearProof(); setMode(value); setAcceptedTerms(false); };
  const confirmLogin = async (id: number) => {
    const status = await session.confirm();
    if (!current(id)) return;
    if (status !== "authenticated" || !loginSubject.current?.userId || sessionStore.getSnapshot().userId !== loginSubject.current.userId) throw new WebAuthError(503, "SESSION_NOT_CONFIRMED", true);
    setPassword(""); setCode(""); setOutcome("idle"); writeLock.current = false;
    publishUserSessionChange(); await onSuccess?.();
  };
  const sendOtp = async () => {
    if (busy || sending || writeLock.current || Date.now() < cooldownUntil) return;
    if (!validContact() || mode === "login" && !acceptedTerms) { validationError(!validContact() ? "请填写有效的手机号或邮箱。" : "请先阅读并同意服务协议与隐私政策。", !validContact() ? "auth-identifier" : "auth-terms"); return; }
    const request = begin(); setSending(true); setError(undefined);
    try {
      const result = await webAuthRequest<{ status: boolean; challengeId?: string; cooldownUntil: string }>(mode === "recover" ? "/security/challenge/send" : "/phone-registration/send-otp", mode === "recover" ? { purpose: "recovery", channel, contact: normalized() } : { phoneNumber: normalized() }, request.controller.signal);
      if (!current(request.id)) return;
      if (result.status !== true || !Number.isFinite(Date.parse(result.cooldownUntil))) throw new WebAuthError(502, "RESPONSE_UNCONFIRMED");
      setChallengeId(result.challengeId ?? ""); setSentFor(normalized()); setCode(""); setCooldownUntil(Date.parse(result.cooldownUntil)); setNow(Date.now());
      setNotice(mode === "recover" ? "如果该联系方式可用于恢复，验证码会发送至该联系方式。" : "验证码已发送至 " + maskPhone(contact) + "。");
    } catch (failure) { if (current(request.id)) { setError(authErrorMessage(failure)); if (failure instanceof WebAuthError && failure.retryAt) { setCooldownUntil(failure.retryAt); setNow(Date.now()); } } }
    finally { if (current(request.id)) setSending(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || sending || writeLock.current) return;
    setError(undefined); setNotice(undefined); setInvalidField(undefined);
    if (!validContact() || mode === "login" && !acceptedTerms) { validationError(!validContact() ? "请填写有效的联系方式。" : "请先阅读并同意服务协议与隐私政策。", !validContact() ? "auth-identifier" : "auth-terms"); return; }
    const needsCode = mode === "recover" ? !proofId : method === "sms";
    if (needsCode && (sentFor !== normalized() || !/^\d{6}$/.test(code))) { validationError("请先获取当前联系方式的验证码，并填写 6 位数字。", "phone-registration-code"); return; }
    if (mode === "login" && method === "password" && !password) { validationError("请输入现有密码。", "auth-password"); return; }
    if (mode === "login" && method === "sms" && inviteCode.trim() && !/^[A-Za-z0-9_-]{1,30}$/.test(inviteCode.trim())) { validationError("邀请码仅支持30位以内的字母、数字、下划线和连字符。", "auth-invite-code"); return; }
    if (mode === "recover" && proofId && (password.length < 12 || password.length > 128 || password !== confirmation)) { validationError("新密码需要 12–128 位，两次输入须完全一致。", password.length < 12 || password.length > 128 ? "auth-password" : "auth-password-confirm"); return; }
    const request = begin(); setBusy(true);
    const writesIdentity = mode === "login" || Boolean(proofId); if (writesIdentity) writeLock.current = true;
    if (mode === "login") loginSubject.current = { phone: normalized(), userId: null };
    let accepted = false;
    try {
      if (mode === "recover" && !proofId) {
        const result = await webAuthRequest<{ status: boolean; proofId: string }>("/security/challenge/verify", { challengeId, code }, request.controller.signal);
        if (!current(request.id)) return;
        if (!result.proofId || result.status !== true) throw new WebAuthError(502, "RESPONSE_UNCONFIRMED");
        setProofId(result.proofId); setCode(""); setNotice("身份已验证，请设置新密码。成功后需要重新登录。");
        window.setTimeout(() => formRef.current?.querySelector<HTMLInputElement>("#auth-password")?.focus(), 0);
      } else if (mode === "recover") {
        await webAuthRequest("/security/recovery/complete", { proofId, newPassword: password }, request.controller.signal);
        accepted = true; if (!current(request.id)) return;
        setPassword(""); setConfirmation(""); publishUserSessionChange(); await session.confirm();
        if (!current(request.id)) return;
        setProofId(""); setChallengeId(""); setMode("login"); setMethod("password"); if (channel === "email") setContact(""); setChannel("phone"); setAcceptedTerms(false);
        writeLock.current = false; setNotice("密码已重置，旧会话已退出。请使用手机号和新密码登录。");
      } else {
        const result = await webAuthRequest<{ status: boolean; userId: string }>(method === "sms" ? "/phone-registration/complete" : "/sign-in/identifier", method === "sms" ? { phoneNumber: normalized(), code, acceptedTerms: true, loginOrRegister: true, ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}) } : { identifier: normalized(), password, kind: "phone" }, request.controller.signal);
        accepted = true; if (!current(request.id)) return; setOutcome("accepted");
        if (result.status !== true || typeof result.userId !== "string" || !result.userId) throw new WebAuthError(502, "RESPONSE_UNCONFIRMED", true);
        loginSubject.current = { phone: normalized(), userId: result.userId };
        await confirmLogin(request.id);
      }
    } catch (failure) {
      if (!current(request.id)) return;
      const uncertain = writesIdentity && (accepted || failure instanceof WebAuthError && (failure.accepted || failure.status === 0 || failure.status >= 500));
      if (uncertain) { const knownAccepted = accepted || failure instanceof WebAuthError && failure.accepted; setPassword(""); setConfirmation(""); setCode(""); setOutcome(knownAccepted ? "accepted" : "unknown"); setError(knownAccepted ? "操作已接受，后续状态暂未读到。请重新确认，勿重复提交。" : "结果暂时无法确认，请先查询状态，勿重复提交。"); }
      else {
        writeLock.current = false;
        const message = authErrorMessage(failure, mode === "login" && method === "password" ? "login" : "verify");
        if (failure instanceof WebAuthError && (failure.status === 400 || failure.status === 401) && (mode === "login" || !proofId)) validationError(message, mode === "login" && method === "password" ? "auth-password" : "phone-registration-code");
        else setError(message);
      }
    } finally { if (current(request.id)) setBusy(false); }
  };
  const readResult = async () => {
    if (busy) return; const request = begin(); setBusy(true);
    try {
      if (mode === "recover") {
        const result = await webAuthRequest<{ status: string }>("/security/operation", { operationId: proofId }, request.controller.signal);
        if (!current(request.id)) return;
        if (result.status === "expired") { setOutcome("idle"); writeLock.current = false; clearProof(); setCooldownUntil(0); setNotice("服务端已确认原验证过期且重置未完成，请重新验证身份。"); return; }
        if (result.status !== "completed") { setError("结果仍未确认，请稍后再查询。验证在申请后 5 分钟失效，确认过期后可重新验证。"); return; }
        setOutcome("idle"); writeLock.current = false; clearProof(); setMode("login"); setMethod("password"); if (channel === "email") setContact(""); setChannel("phone"); setNotice("密码已重置，请使用手机号和新密码登录。"); publishUserSessionChange();
      } else {
        const status = await session.confirm();
        if (!current(request.id)) return;
        if (status === "authenticated") {
          const expected = loginSubject.current;
          if (!expected) throw new Error("Login subject unavailable");
          if (!expected.userId) {
            const value = await webAuthRequest<{ user: { id: string; phoneNumber?: string } } | null>("/get-session", undefined, request.controller.signal);
            if (!current(request.id)) return;
            if (!value?.user?.id || compactPhone(value.user.phoneNumber ?? "") !== expected.phone) throw new Error("Login subject differs");
            expected.userId = value.user.id;
          }
          if (sessionStore.getSnapshot().userId !== expected.userId) throw new Error("Login identity changed");
          setOutcome("idle"); writeLock.current = false; setGuestConfirmed(false); publishUserSessionChange(); await onSuccess?.();
        }
        else if (status === "guest") { setGuestConfirmed(true); setError("当前没有登录会话，请获取新的验证码重新登录。"); }
        else throw new Error("Session unconfirmed");
      }
    } catch { if (current(request.id)) setError("状态暂时无法读取，请稍后重新确认。"); }
    finally { if (current(request.id)) setBusy(false); }
  };
  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const locked = busy || sending || outcome !== "idle";
  return <section className="auth-form" data-mode={mode} data-auth-form-next={next ?? ""} aria-label="账户认证">
    <h2 className="sr-only">{mode === "recover" ? "找回密码" : "登录洲洲商行"}</h2>
    {contextLabel && <p className="auth-context">{contextLabel}</p>}
    <div className="auth-methods" aria-label={mode === "recover" ? "找回方式" : "登录方式"}>{mode === "recover" ? (["phone", "email"] as const).map(value => <button key={value} type="button" aria-pressed={channel === value} disabled={locked} onClick={() => { clearProof(); setContact(""); setChannel(value); }}>{value === "phone" ? "手机验证" : "邮箱验证"}</button>) : (["sms", "password"] as const).map(value => <button key={value} type="button" aria-pressed={method === value} disabled={locked} onClick={() => { clearProof(); setMethod(value); }}>{value === "sms" ? "验证码登录" : "密码登录"}</button>)}</div>
    <form ref={formRef} className="auth-fields" onSubmit={submit} noValidate>
      <div className="auth-field"><label className="sr-only" htmlFor="auth-identifier">{mode === "recover" && channel === "email" ? "已绑定邮箱" : "手机号"}</label><input id="auth-identifier" aria-invalid={invalidField === "auth-identifier" || undefined} name="identifier" autoFocus={autoFocus} type={mode === "recover" && channel === "email" ? "email" : "tel"} inputMode={mode === "recover" && channel === "email" ? "email" : "tel"} autoComplete={mode === "recover" && channel === "email" ? "email" : "tel"} placeholder={mode === "recover" && channel === "email" ? "已绑定并验证的邮箱" : "大陆手机号"} value={contact} disabled={locked || Boolean(proofId)} onChange={event => { setContact(event.target.value); clearProof(); }} aria-describedby={error ? "auth-status" : undefined} /></div>
      {(mode === "login" && method === "sms" || mode === "recover" && !proofId) && <div className="auth-code-field"><label className="sr-only" htmlFor="phone-registration-code">验证码</label><div className="auth-code-row"><input id="phone-registration-code" aria-invalid={invalidField === "phone-registration-code" || undefined} name="otp" autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} disabled={locked} placeholder="6 位验证码" onChange={event => setCode(event.target.value)} aria-describedby={error ? "auth-status" : undefined} /><button type="button" className="button secondary" disabled={locked || remaining > 0} onClick={() => void sendOtp()}>{sending ? "发送中…" : remaining > 0 ? remaining + "s 后重发" : "获取验证码"}</button></div></div>}
      {mode === "login" && method === "sms" && <p className="auth-field-help">未注册的手机号验证后自动注册，密码可稍后设置。</p>}
      {mode === "login" && method === "sms" && initialInviteCode !== undefined && <div className="auth-field"><label htmlFor="auth-invite-code">邀请码（选填）</label><input id="auth-invite-code" value={inviteCode} maxLength={30} autoComplete="off" disabled={locked} aria-invalid={invalidField === "auth-invite-code" || undefined} onChange={event => setInviteCode(event.target.value)} /><p className="auth-field-help">仅用于新账号注册来源。登录已有账号不会更改邀请关系。</p></div>}
      {(mode === "login" && method === "password" || mode === "recover" && proofId) && <div className="auth-field"><label className="sr-only" htmlFor="auth-password">{mode === "recover" ? "新密码" : "现有密码"}</label><div className="auth-password-row"><input id="auth-password" aria-invalid={invalidField === "auth-password" || undefined} name="password" type={showPassword ? "text" : "password"} value={password} disabled={locked} autoComplete={mode === "recover" ? "new-password" : "current-password"} placeholder={mode === "recover" ? "新密码（12–128 位）" : "请输入现有密码"} onChange={event => setPassword(event.target.value)} aria-describedby={error ? "auth-status" : undefined} /><button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} disabled={locked} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隐藏" : "显示"}</button></div></div>}
      {mode === "recover" && proofId && <div className="auth-field"><label className="sr-only" htmlFor="auth-password-confirm">确认新密码</label><input id="auth-password-confirm" aria-invalid={invalidField === "auth-password-confirm" || undefined} name="password-confirm" type="password" autoComplete="new-password" placeholder="再次输入新密码" value={confirmation} disabled={locked} onChange={event => setConfirmation(event.target.value)} aria-describedby={error ? "auth-status" : undefined} /></div>}
      {mode === "login" && method === "password" && <div className="auth-secondary-actions"><button type="button" disabled={locked} onClick={() => changeMode("recover")}>忘记密码</button></div>}
      <button type="submit" className="button primary auth-submit" disabled={locked} aria-busy={busy || undefined}>{busy ? "处理中…" : mode === "recover" ? proofId ? "重置密码" : "验证身份" : method === "sms" ? "登录 / 注册" : "登录"}</button>
      {mode === "recover" && <button type="button" className="button quiet" disabled={locked} onClick={() => changeMode("login")}>返回登录</button>}
      {mode === "login" && <div className="auth-consent"><input id="auth-terms" aria-invalid={invalidField === "auth-terms" || undefined} name="terms" type="checkbox" checked={acceptedTerms} disabled={locked} onChange={event => setAcceptedTerms(event.target.checked)} /><div><label htmlFor="auth-terms">我已阅读并同意</label><button type="button" onClick={() => setPolicy("平台服务协议")}>《平台服务协议》</button>和<button type="button" onClick={() => setPolicy("用户隐私政策")}>《用户隐私政策》</button></div></div>}
      {policy && <div className="auth-policy-notice" role="status"><strong>{policy}</strong><p>正式内容尚未提供，当前无法阅读或完成正式协议确认。</p><button type="button" onClick={() => setPolicy(undefined)}>收起说明</button></div>}
      {(error || notice) && <p id="auth-status" className={"auth-status " + (error ? "is-error" : "is-success")} role={error ? "alert" : "status"}>{error ?? notice}</p>}
      {outcome !== "idle" && <button type="button" className="button secondary" disabled={busy} onClick={() => void readResult()}>重新确认结果</button>}
      {guestConfirmed && <button type="button" className="button secondary" disabled={busy} onClick={() => { clearProof(); setOutcome("idle"); writeLock.current = false; setGuestConfirmed(false); setMethod("sms"); }}>使用新的验证码登录</button>}
    </form>
  </section>;
}
