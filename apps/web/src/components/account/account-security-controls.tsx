"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Laptop,
  LockKeyhole,
  Mail,
  Monitor,
  MoreHorizontal,
  RotateCw,
  Smartphone,
  Tablet,
  X,
  type LucideIcon,
} from "lucide-react";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { authErrorMessage, webAuthRequest, WebAuthError } from "@/lib/web-auth-request";
import { maskPhone } from "../auth/auth-form";
import { Callout, FieldGroup, LocalRetry, RecordStatus, RecoveryAlert, SkeletonBlock } from "@/components/ui/information";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { browserTimezone, CurrentNetworkFields } from "@/components/account/network-info";

type Overview = { userId: string; nickname: string; phoneNumber: string | null; email: string | null; passwordState: "set" | "not-set" | "unavailable" };
type Session = { id: string; isCurrent: boolean; createdAt: string; expiresAt: string; userAgent: string | null };
type Action = "password" | "email" | "phone";
type Scope = "one" | "others" | "all";
type Pending = { action: Action | "nickname" | "sessions" | "account-cancel"; operationId?: string; expected?: string; sessionId?: string; scope?: Scope };
type RevokeTarget = { scope: Scope; sessionId?: string; rows: { label: string; detail: string }[] };
export type SecurityNicknameDraft = { current: { userId: string; value: string } | null };
export type SecurityPendingWrite = { current: { userId: string; intent: Pending; accepted: boolean; target: string } | null };

const SECURITY_ACTIONS = new Set(["password", "email", "phone", "sessions"]);
type Props = { userId: string; canAct: () => boolean; pendingWrite?: SecurityPendingWrite };

const beijing = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
/** 设计稿采用 2026.10.13 09:12 的点分紧凑式；用 formatToParts 组装，避免随 locale 漂回年月日。 */
const sessionTime = (value: string) => {
  const parts = Object.fromEntries(beijing.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
};

/** 找回邮箱只做展示脱敏；能否算有效找回方式由服务端 overview.email 决定。 */
export function maskRecoveryEmail(value: string): string {
  const at = value.lastIndexOf("@");
  const local = at < 0 ? value : value.slice(0, at);
  return `${[...local].slice(0, 2).join("")}***${at < 0 ? "" : value.slice(at)}`;
}

/**
 * 设备名称只是浏览器自报 UA 的保守展示派生，不是可信设备证明。
 * missing: 登录时没有 UA 记录
 * unrecognized: 有 UA 但认不出
 * known: 保守派生成功
 */
export type ClientInfo = {
  record: "missing" | "unrecognized" | "known";
  label: string;
  kind: string;
  os: string | null;
  browser: string | null;
  device: "desktop" | "mobile" | "tablet" | "unknown";
};

export function describeClient(userAgent: string | null | undefined): ClientInfo {
  const ua = userAgent?.trim() ?? "";
  if (!ua) return { record: "missing", label: "设备信息未知", kind: "无法确认", os: null, browser: null, device: "unknown" };
  const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPod/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : /Mac OS X/i.test(ua) ? "macOS" : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : null;
  const browser = /CriOS\//.test(ua) ? "Chrome" : /FxiOS\//.test(ua) ? "Firefox" : /EdgiOS\//.test(ua) ? "Edge" : /OPiOS\//.test(ua) ? "Opera" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  if (!os && !browser) return { record: "unrecognized", label: "客户端未识别", kind: "无法确认", os: null, browser: null, device: "unknown" };
  return {
    record: "known",
    label: os && browser ? `${os} · ${browser}` : os ?? browser ?? "客户端未识别",
    kind: /Mobile|Android|iPhone|iPad|Windows Phone|CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? "移动端网页" : "桌面端网页",
    os: os ?? null,
    browser: browser ?? null,
    device: os === "iPad" ? "tablet" : /Mobile|Android|iPhone|iPad|Windows Phone|CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? "mobile" : "desktop",
  };
}

export const clientIcon = (client: ClientInfo): LucideIcon =>
  client.record !== "known" ? Monitor : client.device === "tablet" ? Tablet : client.device === "mobile" ? Smartphone : Laptop;

const workflowTitle = (action: Action) => action === "password" ? "设置或修改密码" : action === "email" ? "绑定或更换邮箱" : "换绑手机号";

export function parseSessions(payload: unknown): Session[] {
  const rows = (payload as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(rows)) throw new Error("Session list unconfirmed");
  return rows.map(row => {
    const item = row as Record<keyof Session, unknown> | null;
    const userAgent = item?.userAgent;
    if (typeof item?.id !== "string" || !item.id || typeof item.isCurrent !== "boolean"
      || !(userAgent === null || userAgent === undefined || typeof userAgent === "string")
      || typeof item.createdAt !== "string" || typeof item.expiresAt !== "string"
      || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.expiresAt))) throw new Error("Session list unconfirmed");
    return { id: item.id, isCurrent: item.isCurrent, createdAt: item.createdAt, expiresAt: item.expiresAt, userAgent: userAgent ?? null };
  });
}
const revokeTitle = (scope: Scope) => scope === "all" ? "退出全部会话？" : scope === "others" ? "退出其他会话？" : "退出此会话？";

export function AccountSecurityControls({ userId, canAct, pendingWrite }: Props) {
  const session = useUserSession();
  const sharedSession = useUserSessionStore();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionsBusy, setSessionsBusy] = useState(true);
  const [sessionsError, setSessionsError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  const inheritedWrite = pendingWrite?.current?.userId === userId && SECURITY_ACTIONS.has(pendingWrite.current.intent.action) ? pendingWrite.current : null;
  const foreignWrite = pendingWrite?.current?.userId === userId && !SECURITY_ACTIONS.has(pendingWrite.current.intent.action) ? pendingWrite.current : null;
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
  const [invalidField, setInvalidField] = useState("");
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const currentProps = useRef({ userId, canAct }); currentProps.current = { userId, canAct };
  const writeLock = useRef(Boolean(inheritedWrite));
  const authInvalidated = useRef(false);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleDocClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreMenuOpen(false);
    };
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreMenuOpen]);

  const retainWrite = (intent: Pending | null, knownAccepted = false) => {
    if (!pendingWrite) return;
    const slot = pendingWrite.current;
    if (slot && slot.userId === userId && !SECURITY_ACTIONS.has(slot.intent.action)) return;
    pendingWrite.current = intent ? { userId, intent, accepted: knownAccepted, target } : null;
  };

  const blockedByForeignWrite = () => {
    const slot = pendingWrite?.current;
    return Boolean(slot && slot.userId === userId && !SECURITY_ACTIONS.has(slot.intent.action));
  };

  const workflow = useRef<HTMLFormElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const active = (id: number) => sequence.current === id && currentProps.current.userId === userId && currentProps.current.canAct();
  const start = () => { controller.current?.abort(); const abort = new AbortController(); controller.current = abort; return { id: ++sequence.current, abort }; };
  const clearProof = () => { setProof(""); setTargetProof(""); setChallenge(""); setCode(""); setPassword(""); setConfirmation(""); setShowPassword(false); setInvalidField(""); setStage("current"); };
  const rejectField = (id: string, message: string) => { setInvalidField(id); setError(message); };

  const invalidateAuth = () => { setOverview(null); setSessions(null); clearProof(); setBusy(false); if (authInvalidated.current) return; authInvalidated.current = true; session.revalidate(); };
  const handleFailure = (failure: unknown, context: "read" | "verify" = "verify") => {
    setError(authErrorMessage(failure, context));
    if (failure instanceof WebAuthError && failure.status === 401) invalidateAuth();
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
    observer.observe(doc.body, { childList: true, subtree: true });
    timer = win.setTimeout(stop, 10_000);
    win.setTimeout(restore, 0);
  };

  const visibleOverview = overview?.userId === userId ? overview : null;
  const verificationChannels = (["phone", "email"] as const).filter(value => value === "phone" ? Boolean(visibleOverview?.phoneNumber) : Boolean(visibleOverview?.email));

  const readOverview = async (id: number, signal: AbortSignal) => {
    const data = await webAuthRequest<Overview>("/security/overview", undefined, signal);
    if (!active(id)) return data;
    if (data.userId !== userId || typeof data.nickname !== "string" || !(data.email === null || typeof data.email === "string") || !(data.phoneNumber === null || typeof data.phoneNumber === "string") || !["set", "not-set", "unavailable"].includes(data.passwordState)) throw new Error("Security subject unconfirmed");
    setOverview(data);
    return data;
  };

  const readOverviewQuietly = async (id: number, signal: AbortSignal) => {
    try { await readOverview(id, signal); }
    catch (failure) {
      if (!active(id)) return;
      if (failure instanceof WebAuthError && failure.status === 401) { invalidateAuth(); return; }
      setOverview(null); setError(authErrorMessage(failure, "read"));
    }
  };

  const fetchSessions = (signal: AbortSignal) => webAuthRequest<unknown>("/security/sessions", undefined, signal).then(parseSessions);

  const readSessions = async (id: number, signal: AbortSignal) => {
    setSessionsBusy(true);
    try {
      const result = await fetchSessions(signal);
      if (!active(id)) return;
      setSessions(result); setSessionsError("");
    } catch (failure) {
      if (!active(id)) return;
      if (failure instanceof WebAuthError && failure.status === 401) { invalidateAuth(); return; }
      setSessions(null); setRevokeTarget(null); setSessionsError(authErrorMessage(failure, "read"));
    } finally { if (active(id)) setSessionsBusy(false); }
  };

  const refresh = async () => {
    if (busy || !canAct()) return;
    const request = start(); setBusy(true); setError(""); setInvalidField("");
    await Promise.all([readOverviewQuietly(request.id, request.abort.signal), readSessions(request.id, request.abort.signal)]);
    if (active(request.id)) setBusy(false);
  };

  const refreshSessions = () => {
    const request = start(); setBusy(true);
    void readSessions(request.id, request.abort.signal).finally(() => { if (active(request.id)) setBusy(false); });
  };

  useEffect(() => {
    authInvalidated.current = false;
    void refresh();
    return () => { sequence.current++; controller.current?.abort(); };
  }, [userId]);

  useEffect(() => {
    if (cooldown <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const choose = (value: Action | null) => {
    if (!value) { closeWorkflow(); return; }
    if (busy || writeLock.current || blockedByForeignWrite()) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearProof(); setTarget(""); setError(""); setNotice(""); setChannel(verificationChannels[0] ?? "phone"); setAction(value);
  };

  const stepSelector = () => targetProof ? "button[type=submit]" : proof && action === "password" ? "#security-password" : stage === "target" ? "#security-code" : action === "password" ? "select" : "#security-target";
  const focusStep = () => workflow.current?.querySelector<HTMLElement>(stepSelector())?.focus();
  useEffect(() => { if (!action) return; focusStep(); }, [action, proof, targetProof, stage]);

  const send = async () => {
    if (!action || busy || writeLock.current || !canAct() || Date.now() < cooldown || blockedByForeignWrite()) return;
    if (action !== "password" && !target) { rejectField("security-target", "请先填写新的联系方式。"); return; }
    const request = start(); setBusy(true); setError(""); setInvalidField("");
    try {
      const result = await webAuthRequest<{ status: boolean; challengeId: string; cooldownUntil: string }>("/security/challenge/send", { purpose: action, channel: stage === "target" ? action === "phone" ? "phone" : "email" : channel, stage, ...(action !== "password" ? { target } : {}), ...(stage === "target" ? { proofId: proof } : {}) }, request.abort.signal);
      if (!active(request.id)) return;
      if (!result.challengeId || !Number.isFinite(Date.parse(result.cooldownUntil))) throw new WebAuthError(502, "RESPONSE_UNCONFIRMED");
      setChallenge(result.challengeId); setCode(""); setCooldown(Date.parse(result.cooldownUntil)); setNow(Date.now()); setNotice("验证码已发送，请填写后完成验证。发送成功不代表身份已验证。");
    } catch (failure) { if (active(request.id)) { handleFailure(failure); if (failure instanceof WebAuthError && failure.retryAt) setCooldown(failure.retryAt); } }
    finally { if (active(request.id)) setBusy(false); }
  };

  const verify = async () => {
    if (!challenge || !/^\d{6}$/.test(code) || busy || writeLock.current || !canAct() || blockedByForeignWrite()) { rejectField("security-code", "请先获取验证码并填写 6 位数字。"); return; }
    const request = start(); setBusy(true); setError(""); setInvalidField("");
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
        const result = await fetchSessions(signal);
        if (intent.scope === "one" && result.some(item => item.id === intent.sessionId) || intent.scope === "others" && result.some(item => !item.isCurrent)) throw new Error("Sessions still present");
        if (active(id)) setSessions(result);
      } else {
        await readOverview(id, signal);
        if (!active(id)) return;
        await readSessions(id, signal);
      }
    } catch (failure) {
      if (active(id) && failure instanceof WebAuthError && failure.status === 401) handleFailure(failure, "read");
      throw failure;
    }
  };

  const mutate = async (route: string, body: Record<string, unknown>, intent: Pending) => {
    if (busy || writeLock.current || !canAct() || blockedByForeignWrite()) return;
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
      if (serverAccepted || failure instanceof WebAuthError && (failure.accepted || failure.status === 0 || failure.status >= 500)) {
        const knownAccepted = serverAccepted || failure instanceof WebAuthError && failure.accepted;
        retainWrite(intent, knownAccepted); setPending(intent); setAccepted(knownAccepted); setPassword(""); setConfirmation(""); setCode("");
        setError(knownAccepted ? "操作已接受，但后续状态暂时读不到。请重新确认，勿重复提交。" : "结果暂时无法确认，请先查询状态，勿重复提交。");
      } else {
        retainWrite(null); writeLock.current = false; handleFailure(failure);
      }
    } finally { if (active(request.id)) setBusy(false); }
  };

  const reconcile = async () => {
    if (!pending || busy || !canAct()) return;
    const request = start(); setBusy(true);
    try {
      await confirmResult(pending, request.id, request.abort.signal);
      if (active(request.id)) { setPending(null); retainWrite(null); writeLock.current = false; closeWorkflow(pending.action); setError(""); setNotice("操作结果已确认。"); publishUserSessionChange(); }
    } catch (failure) {
      if (active(request.id)) {
        if (failure instanceof WebAuthError && failure.code === "PROOF_EXPIRED_UNCOMMITTED") {
          setPending(null); retainWrite(null); writeLock.current = false; clearProof(); setCooldown(0); setAccepted(false); setError(""); setNotice("服务端已确认原验证过期且操作未完成，请重新验证。操作目标已保留。");
        } else {
          setError("结果仍未确认，请稍后再查询。验证在申请后 5 分钟失效，确认过期后可重新验证。");
        }
      }
    } finally { if (active(request.id)) setBusy(false); }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!action || !proof || action !== "password" && !targetProof) return;
    if (action === "password" && (password.length < 12 || password.length > 128)) { rejectField("security-password", "新密码需要 12–128 位。"); return; }
    if (action === "password" && password !== confirmation) { rejectField("security-password-confirm", "两次输入的新密码须完全一致。"); return; }
    void mutate("/security/" + action, { proofId: proof, ...(action === "password" ? { newPassword: password } : { targetProofId: targetProof }) }, { action, operationId: proof });
  };

  const askRevoke = (scope: Scope, item?: Session) => {
    if (busy || pending || writeLock.current || !canAct() || blockedByForeignWrite()) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rows = (scope === "one" ? [item] : sessions?.filter(row => scope === "all" || !row.isCurrent) ?? []).filter((row): row is Session => Boolean(row));
    setRevokeTarget({ scope, sessionId: item?.id, rows: rows.map(row => ({ label: describeClient(row.userAgent).label + (row.isCurrent ? " · 当前会话" : ""), detail: `登录 ${sessionTime(row.createdAt)} · 到期 ${sessionTime(row.expiresAt)}` })) });
  };

  const confirmRevoke = () => {
    const intent = revokeTarget; setRevokeTarget(null);
    if (!intent) return;
    void mutate("/security/sessions/" + (intent.scope === "one" ? "revoke" : "revoke-" + intent.scope), intent.sessionId ? { sessionId: intent.sessionId } : {}, { action: "sessions", scope: intent.scope, sessionId: intent.sessionId });
  };

  const locked = busy || Boolean(pending) || !canAct() || Boolean(foreignWrite);
  const ready = Boolean(proof && (action === "password" || targetProof));
  const remaining = Math.max(0, Math.ceil((cooldown - now) / 1000));
  const fieldAttrs = (id: string) => ({
    id,
    "aria-describedby": [`${id}-helper`, invalidField === id ? "security-result" : ""].filter(Boolean).join(" "),
    "aria-invalid": invalidField === id || undefined,
  });

  if (!canAct()) return <p role="status">正在确认登录身份…</p>;
  const current = sessions?.find(item => item.isCurrent) ?? null;
  const others = sessions?.filter(item => !item.isCurrent) ?? [];
  const knownOthers = others.filter(item => describeClient(item.userAgent).record !== "unrecognized");
  const unknownOthers = others.filter(item => describeClient(item.userAgent).record === "unrecognized");
  const passwordState = visibleOverview?.passwordState;

  const feedback = <>
    {(error || notice) && <p id="security-result" role={error ? "alert" : "status"} className={"account-module-note" + (error ? " is-error" : "")}>{error || notice}</p>}
    {pending && <RecoveryAlert className="sec-recovery" tone="unknown" title="操作结果待确认" problem={accepted ? "操作已被服务端接受，但后续状态暂时读不到。" : "暂时无法确认本次操作是否已经生效。"} impact="本次操作目标已冻结。请勿重复提交，先查询结果。" action={<button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile()}>重新确认结果</button>} details={{ summary: "为什么不能直接重试", body: "重发已被接受的写入会产生第二次变更。查询用同一凭据读取服务端回执，不会新建操作。" }} />}
    {pending && <button type="button" className="button quiet" disabled={busy} onClick={async () => { setBusy(true); try { await session.signOut(); } catch { setError("退出登录尚未确认，原操作结果仍未知，请继续只读查询。"); setBusy(false); } }}>退出登录后重新确认</button>}
  </>;

  return <>
    <div className="account-security-controls" data-user-id={userId}>
      {foreignWrite ? (
        <div className="account-nickname-pending" role="alert">
          <span>{foreignWrite.intent.action === "account-cancel" ? "注销结果尚未确认，安全设置的修改已暂停。" : "昵称修改结果待确认，安全设置的修改已暂停。"}</span>
          {foreignWrite.intent.action === "account-cancel" ? <a href="#account-cancellation" className="button secondary button--xs">查看注销状态</a> : <Link href="/account?view=overview" className="button secondary button--xs">返回总览确认昵称</Link>}
        </div>
      ) : null}

      {/* 1. 登录与找回 */}
      <section className="account-module-card sec-card" aria-labelledby="sec-login-heading">
        <header className="account-card-heading sec-login-head">
          <div className="sec-heading-title">
            <h3 id="sec-login-heading">登录与找回</h3>
            <SecurityInfoTip />
          </div>
          {/* 保持测试可达性与局部失败重试能力 */}
          <button type="button" className="button quiet sec-hidden-desktop" aria-label="刷新安全设置" disabled={locked} onClick={() => void refresh()}>刷新</button>
        </header>
        <p className="sec-card-note">安全设置变更前需验证身份。</p>
        {(!action || !visibleOverview) && feedback}
        {!visibleOverview ? error ? <LocalRetry message="登录与找回信息暂时无法读取。" busy={busy} onRetry={() => void refresh()} /> : <SkeletonBlock label="正在读取登录与找回信息" lines={3} variant="text" /> : <>
          <div className="sec-rows">
            <div className="sec-row">
              <div className="sec-row-icon-cell">
                <Smartphone className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <div className="sec-row-main">
                <strong className="sec-row-title">手机号</strong>
                <span className="sec-row-desc">用于登录账号与身份验证。</span>
              </div>
              <div className="sec-row-state-col">
                <strong className="sec-row-value">{visibleOverview.phoneNumber ? maskPhone(visibleOverview.phoneNumber) : "暂无法确认"}</strong>
                {visibleOverview.phoneNumber ? <span className="sec-badge sec-badge--success">已绑定</span> : <span className="sec-badge sec-badge--neutral">未绑定</span>}
              </div>
              <div className="sec-row-side">
                <button type="button" className="button outline sec-action-btn" disabled={locked} data-security-action="phone" onClick={() => choose("phone")}>
                  {visibleOverview.phoneNumber ? <>更换<span className="sr-only">手机号</span></> : <>绑定<span className="sr-only">手机号</span></>}
                </button>
              </div>
            </div>

            <div className="sec-row">
              <div className="sec-row-icon-cell">
                <LockKeyhole className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <div className="sec-row-main">
                <strong className="sec-row-title">登录密码</strong>
                <span className="sec-row-desc">用于账号登录。</span>
              </div>
              <div className="sec-row-state-col">
                <strong className="sec-row-value" data-password-state={passwordState}>
                  {passwordState === "set" ? "已设置" : passwordState === "not-set" ? "未设置" : "暂无法确认"}
                </strong>
                {passwordState === "unavailable" ? <span className="sec-card-note sec-note-inline">暂时无法确认密码状态，请使用验证码登录</span> : null}
              </div>
              <div className="sec-row-side">
                <button type="button" className="button outline sec-action-btn" disabled={locked} data-security-action="password" onClick={() => choose("password")}>
                  {passwordState === "set" ? <>修改<span className="sr-only">密码</span></> : <>设置<span className="sr-only">密码</span></>}
                </button>
              </div>
            </div>

            <div className="sec-row">
              <div className="sec-row-icon-cell">
                <Mail className="sec-row-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <div className="sec-row-main account-long-value">
                <strong className="sec-row-title">找回邮箱</strong>
                <span className="sec-row-desc">用于找回密码与验证身份，不支持用邮箱登录。</span>
              </div>
              <div className="sec-row-state-col">
                <strong className="sec-row-value">{visibleOverview.email ? maskRecoveryEmail(visibleOverview.email) : "尚未绑定"}</strong>
                {visibleOverview.email ? <span className="sec-badge sec-badge--success">已验证</span> : null}
              </div>
              <div className="sec-row-side">
                <button type="button" className="button outline sec-action-btn" disabled={locked} data-security-action="email" onClick={() => choose("email")}>
                  {visibleOverview.email ? <>更换<span className="sr-only">邮箱</span></> : <>绑定<span className="sr-only">邮箱</span></>}
                </button>
              </div>
            </div>
          </div>
        </>}
      </section>

      {/* 2. 会话与设备 */}
      <section className="account-module-card sec-card sec-card--sessions" aria-labelledby="sec-sessions-heading">
        <header className="account-card-heading sec-sessions-head">
          <div className="sec-heading-title">
            <h3 id="sec-sessions-heading">会话与设备</h3>
          </div>
          <div className="sec-session-tools">
            <button
              type="button"
              className="button outline sec-tool-btn"
              aria-label="刷新会话列表"
              disabled={locked || sessionsBusy}
              onClick={refreshSessions}
            >
              <RotateCw size={13} className={sessionsBusy ? "animate-spin" : ""} aria-hidden="true" />
              <span>刷新</span>
            </button>
            <button
              type="button"
              className="button outline sec-tool-btn"
              disabled={locked || !others.length}
              onClick={() => askRevoke("others")}
            >
              退出其他会话
            </button>
            <div className="sec-more-menu-wrapper" ref={moreMenuRef}>
              <button
                type="button"
                className="button outline sec-tool-icon-btn"
                aria-label="更多会话操作"
                aria-expanded={moreMenuOpen}
                disabled={locked}
                onClick={() => setMoreMenuOpen(v => !v)}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
              {/* 下拉是一组动作，不是下拉菜单栏：不用 role=menu（那需要方向键导航），按钮各自可 Tab 到。 */}
              <div className="sec-dropdown-menu" hidden={!moreMenuOpen}>
                <button
                  type="button"
                  className="sec-dropdown-item is-danger"
                  disabled={locked}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    askRevoke("all");
                  }}
                >
                  退出全部会话
                </button>
              </div>
            </div>
          </div>
        </header>

        {sessionsBusy && !sessions ? <SkeletonBlock label="正在读取会话" lines={3} /> : null}
        {sessionsError ? <LocalRetry message={sessionsError} busy={sessionsBusy} onRetry={refreshSessions} /> : null}

        {sessions && !sessionsError ? <>
          {/* 当前会话置顶 */}
          <section className="sec-current-section" aria-labelledby="sec-current-session-heading">
            {current ? (
              <>
                <CurrentSessionSummary item={current} />
                <CurrentNetworkFields />
              </>
            ) : (
              <p className="sec-session-empty">未读取到当前会话，请刷新后重试。</p>
            )}
          </section>

          {/* 其他有效会话 */}
          <section className="sec-other-sessions" aria-labelledby="sec-other-sessions-heading">
            <div className="sec-other-head">
              <h4 id="sec-other-sessions-heading" className="sec-other-title">其他有效会话</h4>
              <p className="sec-card-note">有效会话不代表设备当前在线。</p>
            </div>

            {knownOthers.length ? (
              <div className="sec-session-table">
                <div className="sec-session-columns" aria-hidden="true">
                  <span>设备与浏览器</span>
                  <span>登录时间</span>
                  <span>操作</span>
                </div>
                <div className="sec-session-list">
                  {knownOthers.map(item => (
                    <SessionRow key={item.id} item={item} locked={locked} onAsk={askRevoke} />
                  ))}
                </div>
              </div>
            ) : null}
            {unknownOthers.length ? (
              <details className="sec-unknown-sessions">
                <summary><span>无法识别的设备（{unknownOthers.length}）</span><small>客户端信息未提供，仍可按登录时间区分并单独退出</small></summary>
                <div className="sec-session-list">
                  {unknownOthers.map(item => (
                    <SessionRow key={item.id} item={item} locked={locked} onAsk={askRevoke} />
                  ))}
                </div>
              </details>
            ) : null}
            {others.length === 0 ? <p className="sec-session-empty">暂无其他有效会话。</p> : null}
          </section>
        </> : null}
      </section>

      {/* 帮助入口 */}
      <div className="sec-help sec-help-guide">
        <HelpCircle size={15} aria-hidden="true" />
        <span>需要帮助？</span>
        <Link href="/help" className="sec-help-link">查看账号安全指南 <ChevronRight size={13} aria-hidden="true" /></Link>
      </div>
    </div>

    <SecurityDialog open={Boolean(action)} onClose={() => choose(null)} title={action ? workflowTitle(action) : ""} steps={action ? <StepList action={action} proof={proof} targetProof={targetProof} /> : null} handFocus onOpened={focusStep}>
      {action ? <form ref={workflow} aria-label={workflowTitle(action)} onSubmit={submit} noValidate>
        {!visibleOverview ? feedback : <>
          {action !== "password" ? <FieldGroup id="security-target" label={action === "phone" ? "新手机号" : "新邮箱"} helper={action === "phone" ? "填写要换绑的大陆手机号。" : "填写要绑定的邮箱；验证通过后才可用于找回密码。"}>
            <input {...fieldAttrs("security-target")} type={action === "phone" ? "tel" : "email"} inputMode={action === "phone" ? "tel" : "email"} autoComplete={action === "phone" ? "tel" : "email"} value={target} disabled={locked} onChange={event => { clearProof(); setTarget(event.target.value); }} />
          </FieldGroup> : null}
          {!ready ? <>
            {stage === "current" ? <>
              <p className="sec-stage-note">{action === "password" ? "验证现有身份后才能设置新密码。" : "先验证现有身份控制权，再验证新的联系方式。"}</p>
              {verificationChannels.length ? <FieldGroup id="security-channel" label="验证方式" helper={`验证码将发送至${channel === "phone" ? "当前手机号" : "已绑定邮箱"}。`} required>
                <select {...fieldAttrs("security-channel")} value={channel} disabled={locked} onChange={event => { clearProof(); setChannel(event.target.value as "phone" | "email"); }}>
                  {verificationChannels.map(value => <option key={value} value={value}>{value === "phone" ? `当前手机号 ${maskPhone(visibleOverview.phoneNumber ?? "")}` : `已绑定邮箱 ${maskRecoveryEmail(visibleOverview.email ?? "")}`}</option>)}
                </select>
              </FieldGroup> : <p className="sec-stage-note" role="note">当前没有可用于验证身份的联系方式。</p>}
            </> : <p className="sec-stage-note">原身份已验证。请验证新的联系方式 <strong>{target}</strong>。</p>}
            <FieldGroup id="security-code" label="验证码" helper="请勿向他人透露验证码。">
              <div className="auth-code-row">
                <input {...fieldAttrs("security-code")} autoComplete="one-time-code" inputMode="numeric" maxLength={6} placeholder="输入 6 位验证码" value={code} disabled={locked} onChange={event => setCode(event.target.value)} />
                <button type="button" className="button secondary" disabled={locked || remaining > 0 || stage === "current" && !verificationChannels.length} onClick={() => void send()}>{remaining > 0 ? remaining + "s 后重发" : "获取验证码"}</button>
              </div>
            </FieldGroup>
            <div className="sec-dialog-actions"><button type="button" className="button quiet" onClick={() => choose(null)}>取消</button><button type="button" className="button primary" disabled={locked || !challenge} onClick={() => void verify()}>验证{stage === "current" ? "现有身份" : "新联系方式"}</button></div>
          </> : <>
            {action === "password" ? <>
              <FieldGroup id="security-password" label="新密码" helper="12–128 位，建议使用密码管理器生成。">
                <div className="auth-password-row">
                  <input {...fieldAttrs("security-password")} type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} disabled={locked} onChange={event => setPassword(event.target.value)} />
                  <button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} disabled={locked} onClick={() => setShowPassword(value => !value)}>{showPassword ? "隐藏" : "显示"}</button>
                </div>
              </FieldGroup>
              <FieldGroup id="security-password-confirm" label="确认新密码">
                <input {...fieldAttrs("security-password-confirm")} type={showPassword ? "text" : "password"} autoComplete="new-password" value={confirmation} disabled={locked} onChange={event => setConfirmation(event.target.value)} />
              </FieldGroup>
            </> : null}
            <Callout tone="neutral" title="本次变更">成功后该账号的其他有效会话都会退出；当前会话继续有效，到期时间不变。</Callout>
            <div className="sec-dialog-actions"><button type="button" className="button quiet" onClick={() => choose(null)}>取消</button><button type="submit" className="button primary" disabled={locked}>确认{action === "password" ? "保存密码" : action === "phone" ? "换绑手机号" : "保存邮箱"}</button></div>
          </>}
          {feedback}
          {error && !pending ? <button type="button" className="button secondary" disabled={locked} onClick={() => { clearProof(); setError(""); setNotice("请重新验证现有身份，操作目标已保留。"); }}>重新验证</button> : null}
        </>}
      </form> : null}
    </SecurityDialog>

    <SecurityDialog open={Boolean(revokeTarget)} onClose={() => setRevokeTarget(null)} title={revokeTarget ? revokeTitle(revokeTarget.scope) : ""} description={revokeTarget ? <RevokeCopy scope={revokeTarget.scope} count={revokeTarget.rows.length} /> : null} confirmLabel="确认退出" cancelLabel="暂不退出" onConfirm={confirmRevoke}>
      {revokeTarget ? <ul className="sec-revoke-list">{revokeTarget.rows.map(row => <li key={row.label + row.detail}><span>{row.label}</span><small>{row.detail}</small></li>)}</ul> : null}
    </SecurityDialog>
  </>;
}

function StepList({ action, proof, targetProof }: { action: Action; proof: string; targetProof: string }) {
  const steps = action === "password" ? ["验证身份", "设置新密码"] : ["验证现有身份", "验证新联系方式", "完成换绑"];
  const index = action === "password" ? proof ? 1 : 0 : targetProof ? 2 : proof ? 1 : 0;
  return <ol className="sec-steps">{steps.map((label, position) => <li key={label} aria-current={position === index ? "step" : undefined} data-state={position < index ? "done" : position === index ? "current" : "todo"}><span>{position + 1}</span>{label}</li>)}</ol>;
}

function RevokeCopy({ scope, count }: { scope: Scope; count: number }) {
  if (scope === "all") return <p>将退出该账号下的全部有效会话，<strong>包括当前会话</strong>，确认后需要重新登录。</p>;
  if (scope === "others") return <p>将退出除当前会话以外的全部有效会话（本次读取到 {count} 个），当前会话继续保留。</p>;
  return <p>只退出下面这一个会话，其他会话与当前会话不受影响。</p>;
}

function LoginRecordBody({ client }: { client: ClientInfo }) {
  return <>
    {client.record === "known" ? <dl className="sec-record-grid">
      <div><dt>系统</dt><dd>{client.os}</dd></div>
      <div><dt>浏览器</dt><dd>{client.browser}</dd></div>
      <div><dt>客户端类型</dt><dd>{client.kind}</dd></div>
    </dl> : <p className="sec-record-missing">{client.record === "missing" ? "登录时未记录客户端信息。" : "登录时记录的客户端信息无法识别，未推断设备名称。"}</p>}
    <p className="sec-record-footnote">客户端信息由登录时浏览器自行提供的 User-Agent 派生，仅供辨认，不构成可信设备证明。</p>
  </>;
}

/** 当前会话卡片 */
function CurrentSessionSummary({ item }: { item: Session }) {
  const local = describeClient(typeof navigator === "undefined" ? null : navigator.userAgent);
  const Icon = clientIcon(local);

  return (
    <div className="sec-current-card">
      <div className="sec-current-hero">
        <div className="sec-current-icon-cell">
          <Icon className="sec-current-icon" size={26} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <div className="sec-current-identity">
          <div className="sec-current-title-row">
            <strong className="sec-current-title" id="sec-current-session-heading">
              {local.record === "known" ? local.label : local.record === "missing" ? "当前浏览器信息未知" : "客户端未识别"}
            </strong>
            <span className="sec-badge sec-badge--current">当前会话</span>
            <span className="sec-card-note sec-note-inline">这是您正在使用的这个浏览器的信息，不会更新到其他会话。</span>
          </div>
          <span className="sec-current-sub">
            当前浏览器 · {local.record === "known" ? local.kind : "设备类型未知"}
          </span>
        </div>
        <dl className="sec-current-timezone">
          <div><dt>浏览器时区</dt><dd>{browserTimezone()}</dd></div>
        </dl>
      </div>

      <div className="sec-divider" />

      <div className="sec-current-bottom">
        <dl className="sec-current-meta">
          <div><dt>登录时间</dt><dd>{sessionTime(item.createdAt)}</dd></div>
          <div><dt>到期时间</dt><dd>{sessionTime(item.expiresAt)}</dd></div>
        </dl>
      </div>
    </div>
  );
}

function SessionRow({ item, locked, onAsk }: { item: Session; locked: boolean; onAsk: (scope: Scope, item: Session) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const detailId = useId();
  const client = describeClient(item.userAgent);
  const Icon = clientIcon(client);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="sec-session" data-record={client.record} data-session-id={item.id}>
      <div className="sec-session-client">
        <Icon className="sec-session-icon" size={18} strokeWidth={1.5} aria-hidden="true" />
        <div className="sec-session-title">
          <strong>{client.label}</strong>
          <span className="sec-session-sub">登录于 {sessionTime(item.createdAt)}</span>
        </div>
      </div>

      <div className="sec-session-when">
        <span className="sec-session-when-label">到期时间</span>
        <time className="sec-session-when-time">{sessionTime(item.expiresAt)}</time>
      </div>

      <div className="sec-session-action">
        <div className="sec-row-menu-wrapper" ref={menuRef}>
          <button
            type="button"
            className="button outline sec-tool-icon-btn sec-row-more-btn"
            aria-label={`操作会话: ${client.label}`}
            aria-expanded={menuOpen}
            disabled={locked}
            onClick={() => setMenuOpen(v => !v)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
          <div className="sec-dropdown-menu" hidden={!menuOpen}>
            <button
              type="button"
              className="sec-dropdown-item sec-session-expand"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={expanded ? "收起" : "详情"}
              onClick={() => {
                setMenuOpen(false);
                setExpanded(v => !v);
              }}
            >
              {expanded ? "收起" : "查看详情"}
            </button>
            <button
              type="button"
              className="sec-dropdown-item is-danger"
              disabled={locked}
              onClick={() => {
                setMenuOpen(false);
                onAsk("one", item);
              }}
            >
              退出此会话
            </button>
          </div>
        </div>
      </div>

      <div className="sec-session-detail" id={detailId} hidden={!expanded}>
        <LoginRecordBody client={client} />
      </div>
    </div>
  );
}

function SecurityInfoTip() {
  const [open, setOpen] = useState(false);
  const origin = useRef<string>("");
  const wrapper = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open || origin.current !== "touch") return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (wrapper.current?.contains(target as Node)) return;
      if (target?.closest?.(".app-tooltip-content")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <span className="sec-info" ref={wrapper}>
      <TooltipProvider delayDuration={180} skipDelayDuration={100}>
        <Tooltip open={open} onOpenChange={setOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="sec-info-trigger"
              aria-label="修改安全设置会影响哪些会话？"
              onPointerDown={event => { origin.current = event.pointerType; if (event.pointerType === "touch") setOpen(value => !value); }}
              onClick={event => { if (origin.current === "touch") event.preventDefault(); }}
            >
              <span aria-hidden="true">?</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="sec-info-content">
            <strong>修改安全设置会影响哪些会话？</strong>
            <p>修改成功后，其他会话将退出；当前会话更新，到期时间不变。</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

function SecurityDialog({ open, onClose, title, description, steps, children, onConfirm, confirmLabel, cancelLabel, handFocus = false, onOpened }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; steps?: ReactNode; children: ReactNode; onConfirm?: () => void; confirmLabel?: string; cancelLabel?: string; handFocus?: boolean; onOpened?: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="sec-dialog" onOpenAutoFocus={event => { if (!onOpened) return; event.preventDefault(); onOpened(); }} onCloseAutoFocus={event => { if (handFocus) event.preventDefault(); }}>
          <Dialog.Title>{title}</Dialog.Title>
          {steps ? <Dialog.Description asChild><div>{steps}</div></Dialog.Description> : null}
          {description ? <Dialog.Description asChild><div>{description}</div></Dialog.Description> : null}
          {children}
          {onConfirm ? <div className="sec-dialog-actions"><button type="button" className="button quiet" onClick={onClose}>{cancelLabel}</button><button type="button" className="button secondary sec-danger" onClick={onConfirm}>{confirmLabel}</button></div> : null}
          <Dialog.Close className="icon-button dialog-close" aria-label="关闭对话框"><X size={18} aria-hidden="true" /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
