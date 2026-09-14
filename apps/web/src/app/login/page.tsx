"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import { publishUserSessionChange, useUserSession } from "@/components/session/user-session-provider";
import { AuthForm, webAuthRequest, WebAuthError } from "@/components/auth/auth-form";
import { accountStatusLabel, cancellationFailureMessage, type UserIdentitySnapshot } from "../user-account-status";
import { BrandLogo } from "@/components/brand/brand-logo";

type Account = { id?: string; name?: string; email?: string; username?: string };
type SessionResponse = { user?: Account; session?: { expiresAt?: string } } | null;
type CancellationResponse = { status: UserIdentitySnapshot["accountStatus"] };
type AccountDetails = { userId: string; account: Account; expiresAt?: string; identity: UserIdentitySnapshot };

function Status({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return <p className={`rounded-lg p-3 text-xs leading-relaxed border ${error ? "border-red-500/40 bg-red-500/10 text-red-400" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"}`} role={error ? "alert" : "status"}>{error ?? success}</p>;
}

function expiryText(expiresAt?: string): string {
  if (!expiresAt) return "服务端会话已建立";
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? "服务端会话已建立" : `会话有效至 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get("next");
  const session = useUserSession();
  const [returnTo, setReturnTo] = useState<string>();
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [cancelLoading, setCancelLoading] = useState(false);
  const currentUserIdRef = useRef<string | null>(null);
  currentUserIdRef.current = session.status === "authenticated" ? session.userId : null;

  useEffect(() => {
    const target = safeReturnTo(nextParam);
    setReturnTo(target && !target.startsWith("/login") ? target : undefined);
  }, [nextParam]);

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
        const identity = await webAuthRequest<UserIdentitySnapshot>("/identity/status", undefined, controller.signal);
        if (!active || controller.signal.aborted || current?.user?.id !== userId) return;
        setDetails({ userId, account: current.user, expiresAt: current.session?.expiresAt, identity });
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
    return () => { active = false; controller.abort(); };
  }, [session.status, session.userId, session.identityVersion]);

  const resetNotice = () => { setError(undefined); setSuccess(undefined); };
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
      setError(failure instanceof WebAuthError ? cancellationFailureMessage(failure.status, failure.code) : "注销未完成，请稍后重试。");
    } finally {
      setCancelLoading(false);
    }
  };

  const accountView = session.status === "authenticated" && session.userId;
  const authFormVisible = session.status !== "loading" && !accountView;
  return <div className="min-h-screen bg-[var(--color-bg-canvas)] text-[var(--color-text-primary)] flex flex-col justify-between p-4 sm:p-8">
    <header className="flex items-center justify-between pb-6 border-b border-[var(--color-border-subtle)] max-w-4xl mx-auto w-full">
      <a href="/" className="flex items-center gap-2"><BrandLogo height={32} showText /></a>
      <a href="/" className="text-xs text-[var(--color-accent-brand)] hover:underline font-semibold">← 返回门户首页</a>
    </header>
    <main className="max-w-md mx-auto w-full my-8 bg-[var(--color-bg-card)] p-6 sm:p-8 rounded-2xl border border-[var(--color-border-default)] shadow-xl">
      <div>
        {session.status === "loading" ? <div className="space-y-3" role="status"><h1 className="text-xl font-bold">正在确认登录身份…</h1><p className="text-xs text-[var(--color-text-secondary)]">确认完成前不会展示或操作任何账号资料。</p></div> : session.status === "error" ? <div className="space-y-3" role="alert"><h1 className="text-xl font-bold">暂时无法确认登录身份</h1><p className="text-xs text-[var(--color-text-secondary)]">账号资料与操作已隐藏，不会按未登录处理。</p><button type="button" onClick={session.revalidate} className="rounded-lg border border-[var(--color-border-default)] px-3 py-2 text-xs font-medium hover:bg-[var(--color-bg-elevated)] transition-colors">重试身份确认</button></div> : accountView ? <div className="space-y-6">
        <div className="flex items-center justify-between"><div><span className="text-[10px] font-bold tracking-widest text-[var(--color-accent-brand)] uppercase">MEMBER SESSION</span><h1 className="text-xl font-bold mt-1">欢迎回来，{details?.account.name || session.displayName || "用户"}</h1></div><button type="button" onClick={() => void signOut()} disabled={cancelLoading} className="rounded-lg border border-[var(--color-border-default)] px-3 py-1 text-xs font-medium hover:bg-[var(--color-bg-elevated)] transition-colors">退出</button></div>
        {details ? <><div className="rounded-xl bg-[var(--color-bg-elevated)] p-4 space-y-2 text-xs"><div className="flex justify-between"><span className="text-[var(--color-text-muted)]">账号名</span><span className="font-semibold">{details.account.username || "未提供"}</span></div><div className="flex justify-between"><span className="text-[var(--color-text-muted)]">邮箱</span><span className="font-semibold">{details.account.email || "未提供"}</span></div><div className="flex justify-between"><span className="text-[var(--color-text-muted)]">状态</span><span className="font-semibold">{accountStatusLabel(details.identity.accountStatus)}</span></div></div><p className="text-[11px] text-[var(--color-text-muted)]">{expiryText(details.expiresAt)}；登录状态不代表实名、年龄或发布资格通过。</p></> : detailsError ? <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 space-y-2 text-xs text-red-400" role="alert"><p>账号资料读取失败，已停止展示与操作。</p><button type="button" onClick={session.revalidate} className="rounded-lg border border-[var(--color-border-default)] px-3 py-1 font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated)] transition-colors">重新读取</button></div> : <p className="text-xs text-[var(--color-text-secondary)]" role="status">{detailsLoading ? "正在读取账号资料…" : "账号资料未确认。"}</p>}
        <Status error={error} success={success} /><button type="button" onClick={() => void cancelAccount()} disabled={cancelLoading || !details || details.userId !== session.userId} className="w-full rounded-xl border border-red-500/40 py-2.5 text-xs font-bold text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50">{cancelLoading ? "正在提交…" : "注销账号"}</button>
        </div> : null}
      </div>
      <div hidden={!authFormVisible} aria-hidden={!authFormVisible} className={authFormVisible && session.status === "error" ? "mt-6" : undefined}>
        <AuthForm next={returnTo} onSuccess={() => { if (returnTo) router.replace(returnTo); }} />
      </div>
    </main>
    <footer className="text-center text-xs text-[var(--color-text-muted)] py-4">洲洲商行 · 认证与会话由服务端统一保护</footer>
  </div>;
}

export default function LoginPage() {
  return <Suspense fallback={<div className="min-h-screen bg-[var(--color-bg-canvas)] p-6 text-[var(--color-text-primary)]"><main className="max-w-md mx-auto rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-6" role="status">正在准备认证…</main></div>}><LoginPageContent /></Suspense>;
}
