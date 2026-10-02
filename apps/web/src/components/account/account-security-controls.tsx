"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useUserSession, useUserSessionStore, publishUserSessionChange } from "@/components/session/user-session-provider";
import { webAuthRequest, WebAuthError, authErrorMessage } from "@/lib/web-auth-request";
import { maskPhone } from "../auth/auth-form";

type Overview = { userId: string; nickname: string; phoneNumber: string | null; email: string | null; passwordState: "set" | "not-set" | "unavailable" };
type Session = { id: string; isCurrent: boolean; createdAt: string; expiresAt: string; userAgent: string | null };
type Action = "password" | "email" | "phone";
type Pending = { action: Action | "nickname" | "sessions"; operationId?: string; expected?: string; sessionId?: string; scope?: "one" | "others" | "all" };
export type SecurityNicknameDraft = { current: { userId: string; value: string } | null };
export type SecurityPendingWrite = { current: { userId: string; intent: Pending; accepted: boolean; target: string } | null };
type Props = { userId: string; canAct: () => boolean; nicknameDraft?: SecurityNicknameDraft; pendingWrite?: SecurityPendingWrite };
const sessionTime = (value: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));

export function AccountSecurityControls({ userId, canAct, nicknameDraft, pendingWrite }: Props) {
  const session = useUserSession();
  const sharedSession = useUserSessionStore();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const initialDraft = nicknameDraft?.current?.userId === userId ? nicknameDraft.current.value : null;
  const [nickname, setNickname] = useState(initialDraft ?? "");
  const inheritedWrite = pendingWrite?.current?.userId === userId ? pendingWrite.current : null;
  const inheritedAction = inheritedWrite?.intent.action;
  const [action, setAction] = useState<Action | null>(inheritedAction && ["password", "email", "phone"].includes(inheritedAction) ? inheritedAction as Action : null);
  const [channel, setChannel] = useState<"phone" | "email">("phone");
  const [target, setTarget] = useState(inheritedWrite?.target ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [challenge, setChallenge] = useState("");
  const [proof, setProof] = useState("");
  const [targetProof, setTargetProof] = useState("");
  const [stage, setStage] = useState<"current" | "target">("current");
  const [cooldown, setCooldown] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(inheritedWrite?.intent ?? null);
  const [accepted, setAccepted] = useState(inheritedWrite?.accepted ?? false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [passwordInvalid, setPasswordInvalid] = useState(false);
  const nicknameEdited = useRef(initialDraft !== null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const currentProps = useRef({ userId, canAct }); currentProps.current = { userId, canAct };
  const writeLock = useRef(Boolean(inheritedWrite));
  const retainWrite = (intent: Pending | null, knownAccepted = false) => { if (pendingWrite) pendingWrite.current = intent ? { userId, intent, accepted: knownAccepted, target } : null; };
  const workflow = useRef<HTMLFormElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const active = (id: number) => sequence.current === id && currentProps.current.userId === userId && currentProps.current.canAct();
  const start = () => { controller.current?.abort(); const abort = new AbortController(); controller.current = abort; return { id: ++sequence.current, abort }; };
  const clearProof = () => { setProof(""); setTargetProof(""); setChallenge(""); setCode(""); setPassword(""); setConfirmation(""); setPasswordInvalid(false); setStage("current"); };
  const handleFailure = (failure: unknown, context: "read" | "verify" = "verify") => {
    setError(authErrorMessage(failure, context));
    if (failure instanceof WebAuthError && failure.status === 401) {
      setOverview(null); setSessions(null); clearProof(); setBusy(false); session.revalidate();
    }
  };
  const closeWorkflow = (completedAction?: Pending["action"]) => {
    clearProof(); setAction(null);
    const doc = document, win = window;
    const completionControl = doc.activeElement instanceof HTMLElement && doc.activeElement.matches("button") && doc.activeElement.closest<HTMLElement>(".account-security-controls")?.dataset.userId === userId ? doc.activeElement : null;
    const trigger = opener.current ?? completionControl, path = win.location.pathname + win.location.search;
    if (!completedAction) { win.setTimeout(() => { if (trigger?.isConnected) trigger.focus(); }, 0); return; }
    const originalRoot = trigger?.closest(".account-security-controls") ?? doc.querySelector(".account-security-controls");
    const originalWorkflow = workflow.current ?? (originalRoot?.contains(doc.activeElement) ? doc.activeElement?.closest("form") : null);
    let focusedOriginal = false;
    let ownedFocus: HTMLElement | null = null;
    let stopped = false;
    let timer: number;
    const observer = new win.MutationObserver(() => restore());
    const stop = () => { stopped = true; observer.disconnect(); win.clearTimeout(timer); };
    const restore = () => {
      if (stopped) return;
      const current = sharedSession.getSnapshot();
      if (win.location.pathname + win.location.search !== path || current.status === "guest" || current.status === "error" || current.userId && current.userId !== userId) { stop(); return; }
      if (current.status !== "authenticated") return;
      if (doc.activeElement !== doc.body && doc.activeElement !== trigger && doc.activeElement !== ownedFocus && !originalWorkflow?.contains(doc.activeElement)) { stop(); return; }
      const root = [...doc.querySelectorAll<HTMLElement>(".account-security-controls")].find(item => item.dataset.userId === userId);
      const target = root?.querySelector<HTMLElement>(`[data-security-action="${completedAction}"]`);
      if (!target) return;
      if (originalRoot?.isConnected && focusedOriginal) return;
      if (!originalRoot?.isConnected && doc.activeElement !== doc.body && doc.activeElement !== trigger) { stop(); return; }
      target.focus();
      ownedFocus = target;
      focusedOriginal = true;
      if (!originalRoot?.isConnected) stop();
    };
    // ponytail: bounded 10s focus handoff across session remount; use a page coordinator if slower refreshes need it.
    observer.observe(doc.body, { childList: true, subtree: true });
    timer = win.setTimeout(stop, 10_000);
    win.setTimeout(restore, 0);
  };
  const read = async (id: number, signal: AbortSignal) => {
    const data = await webAuthRequest<Overview>("/security/overview", undefined, signal);
    if (!active(id)) return;
    if (data.userId !== userId || typeof data.nickname !== "string" || !(data.email === null || typeof data.email === "string") || !(data.phoneNumber === null || typeof data.phoneNumber === "string") || !["set", "not-set", "unavailable"].includes(data.passwordState)) throw new Error("Security subject unconfirmed");
    setOverview(data); if (!nicknameEdited.current) setNickname(data.nickname);
    if (sessions) {
      const result = await webAuthRequest<{ sessions: Session[] }>("/security/sessions", undefined, signal);
      if (active(id)) setSessions(result.sessions);
    }
    return data;
  };
  const refresh = async () => {
    if (busy || !canAct()) return;
    const request = start(); setBusy(true); setError("");
    try { await read(request.id, request.abort.signal); } catch (failure) { if (active(request.id)) handleFailure(failure, "read"); }
    finally { if (active(request.id)) setBusy(false); }
  };
  useEffect(() => { void refresh(); return () => { sequence.current++; controller.current?.abort(); }; }, [userId]); // Reads stay bound to the parent's confirmed identity permission.
  useEffect(() => { if (cooldown <= Date.now()) return; const timer = window.setInterval(() => setNow(Date.now()), 250); return () => window.clearInterval(timer); }, [cooldown]);
  const choose = (value: Action | null) => { if (busy || writeLock.current) return; if (value) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; clearProof(); setTarget(""); setChannel("phone"); setError(""); setNotice(""); if (value) setAction(value); else closeWorkflow(); };
  useEffect(() => { if (!action) return; const selector = targetProof ? "button[type=submit]" : proof && action === "password" ? "#security-password" : stage === "target" ? "#security-code" : action === "password" ? "select" : "#security-target"; workflow.current?.querySelector<HTMLElement>(selector)?.focus(); }, [action, proof, targetProof, stage]);
  const send = async () => {
    if (!action || busy || writeLock.current || !canAct() || Date.now() < cooldown) return;
    if (action !== "password" && !target) { setError("请先填写新的联系方式。"); return; }
    const request = start(); setBusy(true); setError("");
    try {
      const result = await webAuthRequest<{ status: boolean; challengeId: string; cooldownUntil: string }>("/security/challenge/send", { purpose: action, channel: stage === "target" ? action === "phone" ? "phone" : "email" : channel, stage, ...(action !== "password" ? { target } : {}), ...(stage === "target" ? { proofId: proof } : {}) }, request.abort.signal);
      if (!active(request.id)) return;
      if (!result.challengeId || !Number.isFinite(Date.parse(result.cooldownUntil))) throw new WebAuthError(502, "RESPONSE_UNCONFIRMED");
      setChallenge(result.challengeId); setCode(""); setCooldown(Date.parse(result.cooldownUntil)); setNow(Date.now()); setNotice("验证码已发送，请及时填写。");
    } catch (failure) { if (active(request.id)) { handleFailure(failure); if (failure instanceof WebAuthError && failure.retryAt) setCooldown(failure.retryAt); } }
    finally { if (active(request.id)) setBusy(false); }
  };
  const verify = async () => {
    if (!challenge || !/^\d{6}$/.test(code) || busy || writeLock.current || !canAct()) { setError("请先获取验证码并填写 6 位数字。"); return; }
    const request = start(); setBusy(true); setError("");
    try {
      const result = await webAuthRequest<{ status: boolean; proofId: string }>("/security/challenge/verify", { challengeId: challenge, code }, request.abort.signal);
      if (!active(request.id)) return;
      if (!result.proofId) throw new WebAuthError(502, "RESPONSE_UNCONFIRMED");
      if (stage === "target") setTargetProof(result.proofId); else { setProof(result.proofId); if (action !== "password") { setStage("target"); setCooldown(0); } }
      setChallenge(""); setCode(""); setNotice(stage === "target" || action === "password" ? "验证完成，请确认本次变更。" : "原身份已验证，接下来验证新的联系方式。");
    } catch (failure) { if (active(request.id)) handleFailure(failure); }
    finally { if (active(request.id)) setBusy(false); }
  };
  const confirmResult = async (intent: Pending, id: number, signal: AbortSignal) => {
    try {
      if (intent.operationId) {
        const receipt = await webAuthRequest<{ status: string; expiresAt?: string }>("/security/operation", { operationId: intent.operationId }, signal);
        if (receipt.status === "expired") throw new WebAuthError(410, "PROOF_EXPIRED_UNCOMMITTED");
        if (receipt.status !== "completed") throw new Error("Operation still unconfirmed");
      }
      if (intent.action === "sessions") {
        if (intent.scope === "all" || intent.scope === "one" && sessions?.find(item => item.id === intent.sessionId)?.isCurrent) {
          const status = await session.confirm(); if (status !== "guest") throw new Error("Sign-out unconfirmed"); return;
        }
        const result = await webAuthRequest<{ sessions: Session[] }>("/security/sessions", undefined, signal);
        if (intent.scope === "one" && result.sessions.some(item => item.id === intent.sessionId) || intent.scope === "others" && result.sessions.some(item => !item.isCurrent)) throw new Error("Sessions still present");
        if (active(id)) setSessions(result.sessions);
      } else {
        const data = await read(id, signal);
        if (!active(id)) return;
        if (intent.action === "nickname") {
          if (!data || data.nickname !== intent.expected) throw new Error("Nickname unconfirmed");
          nicknameEdited.current = false; setNickname(data.nickname);
          if (nicknameDraft?.current?.userId === userId) nicknameDraft.current = null;
        }
      }
    } catch (failure) {
      // A failed identity read does not change whether the preceding write was accepted.
      if (active(id) && failure instanceof WebAuthError && failure.status === 401) handleFailure(failure, "read");
      throw failure;
    }
  };
  const mutate = async (route: string, body: Record<string, unknown>, intent: Pending) => {
    if (busy || writeLock.current || !canAct()) return;
    writeLock.current = true; retainWrite(intent); const request = start(); setBusy(true); setError(""); setNotice(""); setAccepted(false);
    let serverAccepted = false;
    try {
      await webAuthRequest(route, body, request.abort.signal); serverAccepted = true;
      if (!active(request.id)) return;
      setAccepted(true); setPending(intent); setPassword(""); setConfirmation("");
      retainWrite(intent, true);
      await confirmResult(intent, request.id, request.abort.signal);
      if (!active(request.id)) return;
      setPending(null); retainWrite(null); writeLock.current = false; closeWorkflow(intent.action); setNotice("操作已完成，账号状态已确认。");
      publishUserSessionChange();
    } catch (failure) {
      if (!active(request.id)) return;
      if (serverAccepted || failure instanceof WebAuthError && (failure.accepted || failure.status === 0 || failure.status >= 500)) { const knownAccepted = serverAccepted || failure instanceof WebAuthError && failure.accepted; retainWrite(intent, knownAccepted); setPending(intent); setAccepted(knownAccepted); setPassword(""); setConfirmation(""); setCode(""); setError(knownAccepted ? "操作已接受，但后续状态暂时读不到。请重新确认，勿重复提交。" : "结果暂时无法确认，请先查询状态，勿重复提交。"); }
      else { retainWrite(null); writeLock.current = false; handleFailure(failure); }
    } finally { if (active(request.id)) setBusy(false); }
  };
  const reconcile = async () => {
    if (!pending || busy || !canAct()) return;
    const request = start(); setBusy(true);
    try { await confirmResult(pending, request.id, request.abort.signal); if (active(request.id)) { setPending(null); retainWrite(null); writeLock.current = false; closeWorkflow(pending.action); setError(""); setNotice("操作结果已确认。"); publishUserSessionChange(); } }
    catch (failure) { if (active(request.id)) {
      if (failure instanceof WebAuthError && failure.code === "PROOF_EXPIRED_UNCOMMITTED") { setPending(null); retainWrite(null); writeLock.current = false; clearProof(); setCooldown(0); setAccepted(false); setError(""); setNotice("服务端已确认原验证过期且操作未完成，请重新验证。操作目标已保留。"); }
      else setError("结果仍未确认，请稍后再查询。验证在申请后 5 分钟失效，确认过期后可重新验证。");
    } }
    finally { if (active(request.id)) setBusy(false); }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!action || !proof || action !== "password" && !targetProof) return;
    if (action === "password" && (password.length < 12 || password.length > 128 || password !== confirmation)) { setPasswordInvalid(true); setError("密码需要 12–128 位，两次输入须完全一致。"); workflow.current?.querySelector<HTMLElement>(password.length < 12 || password.length > 128 ? "#security-password" : "#security-password-confirm")?.focus(); return; }
    void mutate("/security/" + action, { proofId: proof, ...(action === "password" ? { newPassword: password } : { targetProofId: targetProof }) }, { action, operationId: proof });
  };
  const listSessions = async () => { if (busy || pending || !canAct()) return; const request = start(); setBusy(true); try { const result = await webAuthRequest<{ sessions: Session[] }>("/security/sessions", undefined, request.abort.signal); if (active(request.id)) setSessions(result.sessions); } catch (failure) { if (active(request.id)) handleFailure(failure, "read"); } finally { if (active(request.id)) setBusy(false); } };
  const revoke = (scope: "one" | "others" | "all", sessionId?: string) => { if (!window.confirm(scope === "all" ? "确认退出全部设备？当前页面也会退出登录。" : scope === "others" ? "确认退出其他设备？当前会话继续有效。" : "确认退出这个会话？")) return; void mutate("/security/sessions/" + (scope === "one" ? "revoke" : "revoke-" + scope), sessionId ? { sessionId } : {}, { action: "sessions", scope, sessionId }); };
  const locked = busy || Boolean(pending) || !canAct();
  const ready = Boolean(proof && (action === "password" || targetProof));
  const remaining = Math.max(0, Math.ceil((cooldown - now) / 1000));
  if (!canAct()) return <p role="status">正在确认登录身份…</p>;
  const visibleOverview = overview?.userId === userId ? overview : null;
  const feedback = <>
    {(error || notice) && <p id="security-result" role={error ? "alert" : "status"} className={"account-module-note" + (error ? " is-error" : "")}>{error || notice}</p>}
    {pending && <><p role="status">{accepted ? "写入已接受，等待状态确认。" : "写入结果未知，等待状态确认。"}</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile()}>只查询操作结果</button></>}
    {pending && <button type="button" className="button quiet" disabled={busy} onClick={async () => { setBusy(true); try { await session.signOut(); } catch { setError("退出登录尚未确认，原操作结果仍未知，请继续只读查询。"); setBusy(false); } }}>退出登录后重新确认</button>}
  </>;
  return <section className="account-module-card account-security-controls" aria-label="登录与账号资料" data-user-id={userId}>
    <header className="account-card-heading"><h3>登录与账号资料</h3><button type="button" className="button quiet" disabled={locked} onClick={() => void refresh()}>刷新</button></header>
    {(!action || !visibleOverview) && feedback}
    {!visibleOverview ? !error && <p role="status">正在读取安全概况…</p> : <>
      <dl className="account-fact-list"><div><dt>用户编号</dt><dd className="account-long-value">{visibleOverview.userId}</dd></div><div><dt>手机号</dt><dd>{visibleOverview.phoneNumber ? maskPhone(visibleOverview.phoneNumber) : "暂无法确认"}</dd></div><div><dt>找回邮箱</dt><dd className="account-long-value">{visibleOverview.email ?? "未绑定"}</dd></div><div><dt>密码</dt><dd>{visibleOverview.passwordState === "set" ? "已设置" : visibleOverview.passwordState === "not-set" ? "未设置，可继续验证码登录" : "暂无法确认，请使用验证码登录或找回密码"}</dd></div></dl>
      <form aria-label="修改昵称" onSubmit={event => { event.preventDefault(); if (!nickname.trim() || [...nickname].length > 64) { setError("昵称需要 1–64 个字符。"); return; } void mutate("/profile/nickname", { nickname }, { action: "nickname", expected: nickname }); }} className="auth-fields"><label htmlFor="security-nickname">昵称</label><input id="security-nickname" value={nickname} disabled={locked} autoComplete="nickname" onChange={event => { nicknameEdited.current = true; if (nicknameDraft) nicknameDraft.current = { userId, value: event.target.value }; setNickname(event.target.value); }} aria-describedby={error ? "security-result" : undefined} /><button data-security-action="nickname" className="button secondary" type="submit" disabled={locked}>保存昵称</button></form>
      <div className="supply-inline-actions"><button type="button" className="button secondary" disabled={locked} data-security-action="password" onClick={() => choose("password")}>{visibleOverview.passwordState === "not-set" ? "设置密码" : "修改密码"}</button><button type="button" className="button secondary" disabled={locked} data-security-action="email" onClick={() => choose("email")}>{visibleOverview.email ? "更换邮箱" : "绑定邮箱"}</button><button type="button" className="button secondary" disabled={locked} data-security-action="phone" onClick={() => choose("phone")}>换绑手机号</button><button type="button" className="button secondary" disabled={locked} data-security-action="sessions" onClick={() => void listSessions()}>管理有效会话</button></div>
      {action && <form ref={workflow} className="auth-fields" onSubmit={submit} aria-label={action === "password" ? "设置或修改密码" : action === "email" ? "绑定或更换邮箱" : "换绑手机号"}>
        <h4>{action === "password" ? "设置或修改密码" : action === "email" ? "绑定或更换邮箱" : "换绑手机号"}</h4>
        {action !== "password" && <><label htmlFor="security-target">{action === "phone" ? "新手机号" : "新邮箱"}</label><input id="security-target" type={action === "phone" ? "tel" : "email"} inputMode={action === "phone" ? "tel" : "email"} autoComplete={action === "phone" ? "tel" : "email"} value={target} disabled={locked} onChange={event => { clearProof(); setTarget(event.target.value); }} aria-describedby={error ? "security-result" : undefined} /></>}
        {!ready && <><p>{stage === "current" ? "先验证现有身份控制权。" : "再验证新联系方式，完成后才会替换。"}</p>{stage === "current" && <label>验证方式<select value={channel} disabled={locked} onChange={event => { clearProof(); setChannel(event.target.value as "phone" | "email"); }}><option value="phone">当前手机号</option>{visibleOverview.email && <option value="email">已绑定邮箱</option>}</select></label>}<label htmlFor="security-code">验证码</label><div className="auth-code-row"><input id="security-code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} disabled={locked} onChange={event => setCode(event.target.value)} aria-describedby={error ? "security-result" : undefined} /><button type="button" className="button secondary" disabled={locked || remaining > 0} onClick={() => void send()}>{remaining > 0 ? remaining + "s 后重发" : "获取验证码"}</button></div><button type="button" className="button secondary" disabled={locked || !challenge} onClick={() => void verify()}>验证{stage === "current" ? "现有身份" : "新联系方式"}</button></>}
        {ready && action === "password" && <><label htmlFor="security-password">新密码（12–128 位）</label><input id="security-password" type="password" autoComplete="new-password" value={password} disabled={locked} onChange={event => setPassword(event.target.value)} aria-invalid={passwordInvalid && (password.length < 12 || password.length > 128) || undefined} aria-describedby={error ? "security-result" : undefined} /><label htmlFor="security-password-confirm">确认新密码</label><input id="security-password-confirm" type="password" autoComplete="new-password" value={confirmation} disabled={locked} onChange={event => setConfirmation(event.target.value)} aria-invalid={passwordInvalid && password !== confirmation || undefined} aria-describedby={error ? "security-result" : undefined} /></>}
        {ready && <p>成功后将退出其他旧会话，当前会话换发且不延长原到期时间。</p>}
        {feedback}
        <button type="submit" className="button primary" disabled={locked || !ready}>确认{action === "password" ? "保存密码" : action === "phone" ? "换绑手机号" : "保存邮箱"}</button><button type="button" className="button quiet" disabled={locked} onClick={() => choose(null)}>取消</button>
        {error && !pending && <button type="button" className="button secondary" disabled={locked} onClick={() => { clearProof(); setError(""); setNotice("请重新验证现有身份，操作目标已保留。"); }}>重新验证</button>}
      </form>}
      {sessions && <section aria-label="有效会话"><h4>有效会话</h4><p>时间为北京时间（UTC+8）。有效会话不代表设备当前在线。</p>{sessions.map(item => <article key={item.id} className="account-session-row"><strong>{item.isCurrent ? "当前会话" : "其他会话"}</strong><p className="account-long-value">{item.userAgent || "客户端信息未知"}</p><p>登录：{sessionTime(item.createdAt)}<br />到期：{sessionTime(item.expiresAt)}</p><button type="button" className="button secondary" disabled={locked} onClick={() => revoke("one", item.id)}>退出{item.isCurrent ? "当前" : "此"}会话</button></article>)}<div className="supply-inline-actions"><button type="button" className="button secondary" disabled={locked} onClick={() => revoke("others")}>退出其他设备</button><button type="button" className="button secondary" disabled={locked} onClick={() => revoke("all")}>退出全部设备</button></div></section>}
    </>}
  </section>;
}
