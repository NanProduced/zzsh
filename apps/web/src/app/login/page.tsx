"use client";

import { Suspense, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import { useUserSession } from "@/components/session/user-session-provider";
import { AuthForm } from "@/components/auth/auth-form";
import { BrandLogo } from "@/components/brand/brand-logo";

function safeLoginTarget(value: string | null): string | undefined {
  const target = safeReturnTo(value);
  return target && !target.startsWith("/login") ? target : undefined;
}

function intentLabel(target?: string): string | undefined {
  const pathname = target?.split(/[?#]/, 1)[0];
  if (pathname === "/publish" || pathname?.startsWith("/publish/")) return "登录后继续上架出租";
  if (pathname === "/account" || pathname?.startsWith("/account/")) return "登录后继续查看个人中心";
  return undefined;
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = safeLoginTarget(searchParams.get("next"));
  const session = useUserSession();
  const redirectedRef = useRef(false);

  const redirectAfterAuth = useCallback(() => {
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    router.replace(returnTo ?? "/account?view=accounts");
  }, [returnTo, router]);

  useEffect(() => {
    if (session.status === "authenticated") redirectAfterAuth();
  }, [redirectAfterAuth, session.status]);

  const formHidden = session.status === "loading" || session.status === "authenticated";
  return <div className="auth-page">
    <header className="auth-page-header">
      <Link href="/" className="auth-page-brand" aria-label="洲洲商行首页"><BrandLogo height={36} /></Link>
      <Link href="/" className="auth-page-back">返回门户首页</Link>
    </header>
    <main className="auth-page-main">
      <section className="auth-page-card" aria-labelledby="login-page-title">
        <h1 id="login-page-title" className="sr-only">账户登录</h1>
        {session.status === "loading" ? <div className="auth-page-session-state" role="status" aria-live="polite"><h2>正在准备登录…</h2><div className="auth-page-skeleton" aria-hidden="true"><span /><span /><span /></div></div> : null}
        {session.status === "error" ? <div className="auth-page-session-state is-error" role="alert"><h2>暂时无法确认账号状态</h2><p>登录表单仍可使用；如果未能继续，请重试。</p><button type="button" className="button quiet" onClick={session.revalidate}>重试</button></div> : null}
        <div hidden={formHidden} aria-hidden={formHidden}>
          <AuthForm next={returnTo} contextLabel={intentLabel(returnTo)} onSuccess={redirectAfterAuth} />
        </div>
        {session.status === "authenticated" ? <div className="auth-page-session-state" role="status"><h2>登录成功</h2><p>正在进入个人中心…</p></div> : null}
      </section>
    </main>
    <footer className="auth-page-footer">洲洲商行 · 公开浏览无需登录</footer>
  </div>;
}

export default function LoginPage() {
  return <Suspense fallback={<div className="auth-page"><main className="auth-page-main"><section className="auth-page-card" role="status"><h1>正在准备登录…</h1><div className="auth-page-skeleton" aria-hidden="true"><span /><span /><span /></div></section></main></div>}><LoginPageContent /></Suspense>;
}
