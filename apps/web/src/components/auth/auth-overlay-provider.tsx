"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import { useUserSession } from "@/components/session/user-session-provider";
import { BrandLogo } from "@/components/brand/brand-logo";
import { AuthForm } from "./auth-form";

type AuthCallback = () => void | Promise<void>;
type AuthIntent = { id: number; target: string; onSuccess?: AuthCallback };
type AuthOverlayApi = { open: (next?: string, onSuccess?: AuthCallback) => void };
const AuthOverlayContext = createContext<AuthOverlayApi | null>(null);

export function useAuthOverlay(): AuthOverlayApi {
  const value = useContext(AuthOverlayContext);
  if (!value) throw new Error("AuthOverlayProvider is required");
  return value;
}

function protectedPath(pathname: string): boolean {
  return pathname === "/publish" || pathname.startsWith("/publish/") || pathname === "/account" || pathname.startsWith("/account/");
}

function intentLabel(target?: string): string | undefined {
  const pathname = target?.split(/[?#]/, 1)[0];
  if (pathname === "/publish" || pathname?.startsWith("/publish/")) return "登录后继续上架出租";
  if (pathname === "/account" || pathname?.startsWith("/account/")) return "登录后继续查看个人中心";
  return undefined;
}

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

export function AuthOverlayProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useUserSession();
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState<string>();
  const [sessionReadFailed, setSessionReadFailed] = useState(false);
  const intentRef = useRef<AuthIntent | null>(null);
  const pendingRef = useRef<AuthIntent | null>(null);
  const generationRef = useRef(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeReasonRef = useRef<"success" | null>(null);

  const activateIntent = useCallback((intent: AuthIntent) => {
    if (intent.id !== generationRef.current) return;
    closeReasonRef.current = null;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    intentRef.current = intent;
    setNext(intent.target);
    setSessionReadFailed(false);
    setOpen(true);
  }, []);

  const completeIntent = useCallback(async (intent: AuthIntent) => {
    if (intent.id !== generationRef.current) return;
    try {
      await intent.onSuccess?.();
    } catch {
      return;
    }
    if (intent.id !== generationRef.current) return;
    if (intent.target !== currentPath()) router.push(intent.target);
  }, [router]);

  const cancelIntent = useCallback(() => {
    generationRef.current += 1;
    closeReasonRef.current = null;
    pendingRef.current = null;
    intentRef.current = null;
    setNext(undefined);
    setSessionReadFailed(false);
    setOpen(false);
  }, []);

  const openAuth = useCallback((target?: string, onSuccess?: AuthCallback) => {
    closeReasonRef.current = null;
    const intent: AuthIntent = {
      id: ++generationRef.current,
      target: safeReturnTo(target) ?? currentPath(),
      onSuccess,
    };
    pendingRef.current = null;
    setSessionReadFailed(false);
    if (session.status === "authenticated") {
      void completeIntent(intent);
      return;
    }
    // Explicit sign-in opens the form even when session discovery is unavailable.
    // Protected navigation/callbacks still wait for confirmed identity below.
    if (target === undefined && onSuccess === undefined) {
      activateIntent(intent);
      return;
    }
    if (session.status !== "guest") {
      pendingRef.current = intent;
      setSessionReadFailed(session.status === "error");
      if (session.status === "loading") session.revalidate();
      return;
    }
    activateIntent(intent);
  }, [activateIntent, completeIntent, session.revalidate, session.status]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (session.status === "authenticated") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || !protectedPath(url.pathname)) return;
      event.preventDefault();
      openAuth(url.pathname + url.search);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [openAuth, session.status]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || pending.id !== generationRef.current || session.status === "loading") return;
    if (session.status === "error") {
      setSessionReadFailed(true);
      return;
    }
    pendingRef.current = null;
    if (session.status === "guest") {
      activateIntent(pending);
      return;
    }
    void completeIntent(pending);
  }, [activateIntent, completeIntent, session.status]);

  const finish = useCallback(async () => {
    const intent = intentRef.current;
    if (!open || !intent || intent.id !== generationRef.current) return;
    closeReasonRef.current = "success";
    intentRef.current = null;
    setOpen(false);
    setNext(undefined);
    try {
      await intent.onSuccess?.();
    } catch {
      return;
    }
    if (intent.id !== generationRef.current) return;
    if (intent.target !== currentPath()) router.push(intent.target);
  }, [open, router]);

  const onOpenChange = useCallback((value: boolean) => {
    if (value) {
      setOpen(true);
      return;
    }
    if (closeReasonRef.current === "success") {
      closeReasonRef.current = null;
      setOpen(false);
      return;
    }
    cancelIntent();
  }, [cancelIntent]);

  return <AuthOverlayContext.Provider value={{ open: openAuth }}>
    {children}
    {sessionReadFailed ? <div className="auth-session-pending" role="alert">
      <span>暂时无法打开该入口，请重试。</span>
      <button type="button" className="button quiet" onClick={() => {
        setSessionReadFailed(false);
        session.revalidate();
      }}>重试</button>
    </div> : null}
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay auth-modal-overlay" />
        <Dialog.Content className="auth-dialog-content" aria-describedby="auth-overlay-description" onCloseAutoFocus={(event) => {
          if (triggerRef.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}>
          <Dialog.Title className="sr-only">登录或注册</Dialog.Title>
          <Dialog.Description id="auth-overlay-description" className="sr-only">{intentLabel(next) ?? "登录或注册后继续当前操作。关闭窗口会留在当前页面。"}</Dialog.Description>
          <div className="auth-dialog-heading"><Dialog.Close className="icon-button" aria-label="关闭认证窗口"><X size={20} /></Dialog.Close></div>
          <div className="auth-dialog-layout">
            <aside className="auth-brand-panel" aria-label="洲洲品牌"><img className="auth-brand-scene auth-art-light" src="/art/zhouzhou/auth-light.webp" alt="洲洲陪你一起游戏"/><img className="auth-brand-scene auth-art-dark" src="/art/zhouzhou/auth-dark.webp" alt="洲洲在这里等你"/><div className="auth-brand-copy"><BrandLogo height={32}/><p>玩得更远，<br/>一直有洲洲</p></div></aside>
            <div className="auth-dialog-form"><AuthForm next={next} contextLabel={intentLabel(next)} onSuccess={finish} /></div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </AuthOverlayContext.Provider>;
}
