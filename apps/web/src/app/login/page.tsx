"use client";

import { Suspense, useEffect, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import { useUserSession } from "@/components/session/user-session-provider";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { BrandLogo } from "@/components/brand/brand-logo";

function safeLoginTarget(value: string | null): string | undefined {
  const target = safeReturnTo(value);
  return target && !target.startsWith("/login") ? target : undefined;
}

/**
 * Legacy `/login?next=…&inviteCode=…` entry. It stays reachable for old links but renders no form of
 * its own: the shared IP dialog is the only presentation layer, so a guest forwarded here (for
 * example from the personal centre) can never end up with two forms on screen.
 */
function LoginPageContent() {
  const searchParams = useSearchParams();
  const returnTo = safeLoginTarget(searchParams.get("next"));
  const inviteCode = searchParams.get("inviteCode") ?? undefined;
  const session = useUserSession();
  const auth = useAuthOverlay();
  const openedFor = useRef<string | null>(null);
  const target = returnTo ?? "/account?view=accounts";

  useEffect(() => {
    if (session.status === "loading" || session.status === "error") return;
    const request = session.status + "|" + target + "|" + (inviteCode ?? "");
    if (openedFor.current === request) return;
    openedFor.current = request;
    auth.open(target, undefined, { inviteCode, replace: true });
  }, [auth, inviteCode, session.status, target]);

  const openForm = () => auth.open(undefined, undefined, { inviteCode, replace: true });

  const loading = session.status === "loading";
  const failed = session.status === "error";
  const confirmed = session.status === "authenticated";
  return <div className="auth-page">
    <header className="auth-page-header">
      <Link href="/" className="auth-page-brand" aria-label="洲洲商行首页"><BrandLogo height={36} /></Link>
      <Link href="/" className="auth-page-back">返回门户首页</Link>
    </header>
    <main className="auth-page-main">
      <section className="auth-page-card" aria-labelledby="login-page-title">
        <h1 id="login-page-title" className="sr-only">账户登录</h1>
        {loading ? <div className="auth-page-session-state" role="status" aria-live="polite"><h2>正在准备登录…</h2><div className="auth-page-skeleton" aria-hidden="true"><span /><span /><span /></div></div> : null}
        {failed ? <div className="auth-page-session-state is-error" role="alert"><h2>暂时无法确认账号状态</h2><p>登录窗口暂时无法打开；可以先重试账号状态确认，或直接打开登录表单。</p><div className="auth-page-session-actions"><button type="button" className="button secondary" onClick={session.revalidate}>重试</button><button type="button" className="button primary" onClick={openForm}>打开登录窗口</button></div></div> : null}
        {confirmed ? <div className="auth-page-session-state" role="status"><h2>登录成功</h2><p>正在进入个人中心…</p></div> : null}
        {!loading && !failed && !confirmed ? <div className="auth-page-session-state" role="status"><h2>正在打开登录窗口</h2><p>登录窗口内完成登录后会回到{returnTo ? "你原本要去的页面" : "个人中心"}。</p></div> : null}
      </section>
    </main>
    <footer className="auth-page-footer">洲洲商行 · 公开浏览无需登录</footer>
  </div>;
}

export default function LoginPage() {
  return <Suspense fallback={<div className="auth-page"><main className="auth-page-main"><section className="auth-page-card" role="status"><h1>正在准备登录…</h1><div className="auth-page-skeleton" aria-hidden="true"><span /><span /><span /></div></section></main></div>}><LoginPageContent /></Suspense>;
}
