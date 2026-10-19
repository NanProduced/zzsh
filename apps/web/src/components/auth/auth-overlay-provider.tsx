"use client";

import { Suspense, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { safeReturnTo } from "@/lib/safe-return";
import { useUserSession } from "@/components/session/user-session-provider";
import { BrandLogo } from "@/components/brand/brand-logo";
import { AuthForm, type AuthPendingWrite } from "./auth-form";

type AuthCallback = () => void | Promise<void>;
type AuthIntent = {
  id: number;
  /** Cancelling this intent must move the visitor off a page that cannot stand alone. */
  leaveOnCancel: boolean;
  from: string;
  routeBound?: boolean;
  target: string;
  replace?: boolean;
  inviteCode?: string;
  onSuccess?: AuthCallback;
};
type AuthOpenOptions = { inviteCode?: string; replace?: boolean };
type AuthOverlayApi = { open: (next?: string, onSuccess?: AuthCallback, options?: AuthOpenOptions) => void };
const AuthOverlayContext = createContext<AuthOverlayApi | null>(null);

export function useAuthOverlay(): AuthOverlayApi {
  const value = useContext(AuthOverlayContext);
  if (!value) throw new Error("AuthOverlayProvider is required");
  return value;
}

function pathOnly(value: string): string {
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

function protectedPath(target: string): boolean {
  const pathname = pathOnly(target);
  return pathname === "/publish" || pathname.startsWith("/publish/") || pathname === "/account" || pathname.startsWith("/account/") || pathname === "/support" || pathname.startsWith("/support/");
}

/** A page a cancelled protected-entry login may safely land on: same-site, public, never /login. */
function publicSource(value: string | null | undefined): string | undefined {
  const safe = safeReturnTo(value);
  if (!safe) return undefined;
  try {
    const url = new URL(safe, window.location.origin);
    const decoded = safeReturnTo(decodeURIComponent(url.pathname));
    if (!decoded || url.origin !== window.location.origin) return undefined;
    const pathname = new URL(decoded, url.origin).pathname;
    if (pathname === "/login" || protectedPath(pathname)) return undefined;
    return url.pathname + url.search + url.hash;
  } catch { return undefined; }
}

const PUBLIC_SOURCE_KEY = "zzsh-auth-public-source:v1";

function rememberPublicSource(value: string): void {
  const source = publicSource(value);
  if (!source) return;
  try { window.sessionStorage.setItem(PUBLIC_SOURCE_KEY, source); } catch { /* storage may be unavailable */ }
}

function readPublicSource(): string | undefined {
  try { return publicSource(window.sessionStorage.getItem(PUBLIC_SOURCE_KEY)); } catch { return undefined; }
}

/**
 * Where a cancelled protected-entry login lands: a public intent target, else the last public page
 * this tab visited, else the portal home. Never the protected page, never an external URL, and
 * never `history.back()`, which could bounce straight to another site or loop on the protected page.
 */
function safeLanding(target: string): string {
  return publicSource(target) ?? readPublicSource() ?? "/";
}

function intentLabel(target?: string): string | undefined {
  const pathname = pathOnly(target ?? "");
  if (pathname === "/publish" || pathname.startsWith("/publish/")) return "登录后继续上架出租";
  if (pathname === "/account" || pathname.startsWith("/account/")) return "登录后继续查看个人中心";
  if (pathname === "/support" || pathname.startsWith("/support/")) return "登录后继续联系客服";
  return undefined;
}

function currentPath(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

// Keep query observation inside its own Suspense boundary, without suspending the application shell.
function AuthRouteObserver({ onChange }: { onChange: (route: string) => void }) {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  useEffect(() => {
    const sync = () => onChange(currentPath());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [onChange, pathname, query]);
  return null;
}

export function AuthOverlayProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useUserSession();
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState<string>();
  const [inviteCode, setInviteCode] = useState<string>();
  const [sessionReadFailed, setSessionReadFailed] = useState(false);
  const [route, setRoute] = useState(() => typeof window === "undefined" ? pathname : currentPath());
  const accountRoute = pathOnly(route) === "/account" || pathOnly(route).startsWith("/account/");
  const intentRef = useRef<AuthIntent | null>(null);
  const pendingRef = useRef<AuthIntent | null>(null);
  const generationRef = useRef(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeReasonRef = useRef<"success" | null>(null);
  /** The route the visitor just dismissed; replacing the URL takes a render, so the guard must not
   *  treat that gap as a fresh arrival and re-open the dialog it just closed. */
  const dismissedRef = useRef<string | null>(null);
  // Owned here, not by the form: closing the dialog unmounts it, and an accepted/unknown identity
  // write must not become repeatable just because the window was closed and reopened.
  const pendingWrite = useRef<AuthPendingWrite | null>(null);

  const activateIntent = useCallback((intent: AuthIntent) => {
    if (intent.id !== generationRef.current) return;
    closeReasonRef.current = null;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    intentRef.current = intent;
    setNext(intent.target);
    setInviteCode(intent.inviteCode);
    setSessionReadFailed(false);
    setOpen(true);
  }, []);

  const navigateTo = useCallback((intent: AuthIntent) => {
    if (intent.from !== currentPath()) return;
    if (intent.target === currentPath()) return;
    if (intent.replace) router.replace(intent.target);
    else router.push(intent.target);
  }, [router]);

  const completeIntent = useCallback(async (intent: AuthIntent) => {
    if (intent.id !== generationRef.current || pendingWrite.current || intent.from !== currentPath()) return;
    try {
      await intent.onSuccess?.();
    } catch {
      return;
    }
    if (intent.id !== generationRef.current) return;
    navigateTo(intent);
  }, [navigateTo]);

  const cancelIntent = useCallback(() => {
    const intent = intentRef.current;
    const authenticated = session.status === "authenticated";
    generationRef.current += 1;
    closeReasonRef.current = null;
    pendingRef.current = null;
    intentRef.current = null;
    setNext(undefined);
    setInviteCode(undefined);
    setSessionReadFailed(false);
    setOpen(false);
    if (!intent) return;
    dismissedRef.current = currentPath();
    if (!intent.leaveOnCancel || authenticated) return;
    const landing = safeLanding(intent.target);
    if (landing !== currentPath()) router.replace(landing);
  }, [router, session.status]);

  const openAuth = useCallback((target?: string, onSuccess?: AuthCallback, options?: AuthOpenOptions) => {
    closeReasonRef.current = null;
    const intent: AuthIntent = {
      id: ++generationRef.current,
      // The login page is only a shell around this dialog, so closing it must move on.
      leaveOnCancel: pathOnly(currentPath()) === "/login" || protectedPath(currentPath()),
      from: currentPath(),
      target: safeReturnTo(target) ?? currentPath(),
      replace: options?.replace,
      inviteCode: options?.inviteCode,
      onSuccess,
    };
    pendingRef.current = null;
    setSessionReadFailed(false);
    if (pendingWrite.current) {
      activateIntent(intent);
      return;
    }
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
      if (session.status === "error") session.revalidate();
      return;
    }
    activateIntent(intent);
  }, [activateIntent, completeIntent, session.revalidate, session.status]);

  const finish = useCallback(async () => {
    const intent = intentRef.current;
    if (!open || !intent || intent.id !== generationRef.current || pendingWrite.current || intent.from !== currentPath()) return;
    closeReasonRef.current = "success";
    intentRef.current = null;
    setOpen(false);
    setNext(undefined);
    setInviteCode(undefined);
    try {
      await intent.onSuccess?.();
    } catch {
      return;
    }
    if (intent.id !== generationRef.current) return;
    navigateTo(intent);
  }, [navigateTo, open]);

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

  useEffect(() => { rememberPublicSource(route); }, [route]);

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
      openAuth(url.pathname + url.search + url.hash);
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
    if (session.status === "guest" || pendingWrite.current) {
      activateIntent(pending);
      return;
    }
    void completeIntent(pending);
  }, [activateIntent, completeIntent, session.status]);

  // Direct URL, refresh, programmatic navigation and back/forward all land here: once the shared
  // session settles as guest, the one coordinator dialog opens over the protected route instead of
  // leaving the visitor on the route itself. loading stays neutral, error stays retryable.
  useEffect(() => {
    dismissedRef.current = null;
    const intent = intentRef.current;
    if (intent && intent.from !== route) {
      if (intent.routeBound && protectedPath(route)) {
        activateIntent({ id: ++generationRef.current, from: route, routeBound: true, leaveOnCancel: true, target: route });
      } else {
        generationRef.current += 1;
        intentRef.current = null;
        setOpen(false);
        setNext(undefined);
        setInviteCode(undefined);
      }
    }
    if (pendingRef.current && pendingRef.current.from !== route) {
      generationRef.current += 1;
      pendingRef.current = null;
    }
    setSessionReadFailed(false);
  }, [activateIntent, route]);
  useEffect(() => {
    if (!protectedPath(route)) return;
    if (session.status === "guest") {
      if (open || dismissedRef.current === route) return;
      activateIntent({ id: ++generationRef.current, from: route, routeBound: true, leaveOnCancel: true, target: route });
      return;
    }
    if (session.status === "error" && !open) setSessionReadFailed(true);
  }, [activateIntent, open, route, session.status]);

  // A confirmed sign-in that arrived while a leave-on-cancel intent was open (in-form success,
  // cross-tab sign-in) closes the dialog; navigation is skipped when we are already on its target.
  useEffect(() => {
    if (session.status !== "authenticated" || !open || pendingWrite.current) return;
    if (!intentRef.current?.leaveOnCancel) return;
    void finish();
  }, [finish, open, session.status]);

  return <AuthOverlayContext.Provider value={{ open: openAuth }}>
    <Suspense fallback={null}><AuthRouteObserver onChange={setRoute} /></Suspense>
    {children}
    {/* AccountWorkspace owns the full unavailable page; do not duplicate its recovery notice. */}
    {sessionReadFailed && !accountRoute ? <div className="auth-session-pending" role="alert">
      <span>暂时无法打开该入口，请重试。</span>
      <button type="button" className="button quiet" onClick={() => {
        setSessionReadFailed(false);
        session.revalidate();
      }}>重试</button>
    </div> : null}
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay auth-modal-overlay" />
        <Dialog.Content data-auth-dialog className="auth-dialog-content" aria-describedby="auth-overlay-description" onCloseAutoFocus={(event) => {
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
            <div className="auth-dialog-form"><AuthForm next={next} inviteCode={inviteCode} pendingWrite={pendingWrite} onSuccess={finish} /></div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </AuthOverlayContext.Provider>;
}
