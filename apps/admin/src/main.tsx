import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

import { AuthLayout } from "./components/auth-layout";
import { BrandLogo } from "./components/brand-logo";

import { LoginView } from "./views/login-view";
import { ChallengeView } from "./views/challenge-view";
import { OnboardingView } from "./views/onboarding-view";
import { RecoveryView } from "./views/recovery-view";
import { LockScreen } from "./views/lock-screen";
import { WorkspaceApp } from "./workspace/app-shell";
import { clearTabs } from "./workspace/tab-model";

import {
  ADMIN_AUTH_FAILURE_EVENT,
  AdminApiError,
  adminRequest,
  friendlyError,
  readIdleMinutes,
  signal,
  CHANNEL_NAME,
  EVENT_KEY,
  IDLE_KEY,
  type Theme,
  type View,
  type SignalEvent,
  type SessionSnapshot,
  type AuthResponse,
  type EnrollmentResponse,
} from "./api";
import { createSessionRefreshCoordinator, type SessionRefreshCoordinator } from "./session-refresh";

function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1024px)").matches
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return mobile;
}

function useIdleLock(
  enabled: boolean,
  minutes: number,
  sessionId: string | undefined,
  onIdle: () => void
): void {
  const lastActivity = useRef(Date.now());
  const callback = useRef(onIdle);
  callback.current = onIdle;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    lastActivity.current = Date.now();
    let lastBroadcastAt = 0;

    const mark = (at: number, broadcast: boolean) => {
      if (!Number.isFinite(at) || at <= lastActivity.current) return;
      lastActivity.current = at;
      if (broadcast && at - lastBroadcastAt >= 2_000) {
        lastBroadcastAt = at;
        signal("activity", sessionId, at);
      }
    };

    const localActivity = () => mark(Date.now(), true);
    const remoteActivity = (event: Event) => {
      const detail = (event as CustomEvent<SignalEvent>).detail;
      if (detail?.sessionId === sessionId) mark(detail.at, false);
    };

    const events = ["pointerdown", "keydown", "touchstart", "mousemove"] as const;
    for (const event of events) window.addEventListener(event, localActivity, { passive: true });
    window.addEventListener("zzsh:activity", remoteActivity);

    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= minutes * 60_000) {
        lastActivity.current = Date.now();
        callback.current();
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("zzsh:activity", remoteActivity);
      for (const event of events) window.removeEventListener(event, localActivity);
    };
  }, [enabled, minutes, sessionId]);
}


function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const urlTheme = new URLSearchParams(window.location.search).get("theme");
      if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
      if (window.localStorage.getItem("zzsh-admin-theme") === "light") return "light";
    }
    return "dark";
  });
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [view, setView] = useState<View>("login");

  // Form states
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string | undefined>(undefined);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [recoveryNotice, setRecoveryNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [lockError, setLockError] = useState<string>();
  const [idleMinutes, setIdleMinutes] = useState(readIdleMinutes);

  const mobile = useMobileLayout();
  const sessionIdRef = useRef<string | undefined>(undefined);
  const lastSignalKeyRef = useRef<string | undefined>(undefined);
  const sessionRefreshRef = useRef<SessionRefreshCoordinator<SessionSnapshot> | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("zzsh-admin-theme", theme);
  }, [theme]);

  useEffect(() => {
    sessionIdRef.current = snapshot?.authenticated ? snapshot.session.id : undefined;
  }, [snapshot]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const locked = snapshot?.authenticated === true && snapshot.session.locked;
    shell.classList.toggle("is-locked", locked);
    if (locked) {
      shell.setAttribute("aria-hidden", "true");
      shell.setAttribute("inert", "");
    } else {
      shell.removeAttribute("aria-hidden");
      shell.removeAttribute("inert");
    }
  }, [snapshot]);

  const applySession = useCallback((next: SessionSnapshot, redirect = true) => {
    setSnapshot(next);
    if (!redirect) return;
    if (!next.authenticated) {
      clearTabs();
      setView("login");
      setPassword("");
      return;
    }
    if (next.security.status === "PENDING_ENROLLMENT") {
      setView("onboarding");
    } else if (!next.user.twoFactorEnabled) {
      setView("onboarding");
    } else {
      setView("app");
    }
  }, []);

  if (sessionRefreshRef.current === null) {
    sessionRefreshRef.current = createSessionRefreshCoordinator(
      () => adminRequest<SessionSnapshot>("/session"),
      applySession,
    );
  }

  const refreshSession = useCallback((redirect = false): Promise<SessionSnapshot> => {
    return sessionRefreshRef.current!.refresh(redirect);
  }, []);
  const invalidateSessionRefresh = useCallback((cancelQueued = false) => {
    sessionRefreshRef.current?.invalidate(cancelQueued);
  }, []);
  const beginSessionMutation = useCallback(() => {
    sessionRefreshRef.current?.beginMutation();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      sessionRefreshRef.current?.endMutation();
    };
  }, []);

  useEffect(() => {
    const epoch = sessionRefreshRef.current!.getEpoch();
    void refreshSession(true).catch(() => {
      if (sessionRefreshRef.current?.getEpoch() !== epoch) return;
      setSnapshot({ authenticated: false });
      setView("login");
    });
  }, [refreshSession]);

  // Broadcast channel & Storage events for cross-tab session sync
  useEffect(() => {
    const receive = (event: SignalEvent) => {
      if (event.type === "activity") {
        if (event.sessionId === sessionIdRef.current && Number.isFinite(event.at)) {
          window.dispatchEvent(new CustomEvent("zzsh:activity", { detail: event }));
        }
        return;
      }
      if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
      if (event.type === "logout") {
        invalidateSessionRefresh(true);
        clearTabs();
        setSnapshot({ authenticated: false });
        setView("login");
        setPassword("");
        return;
      }
      invalidateSessionRefresh();
      void refreshSession(true).catch(() => undefined);
    };

    const readSignal = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const data = value as Partial<SignalEvent>;
      const type = data.type;
      if (type !== "locked" && type !== "unlocked" && type !== "logout" && type !== "activity") return;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      const at = typeof data.at === "number" ? data.at : 0;
      if (sessionId && sessionId !== sessionIdRef.current) return;
      if (type !== "activity") {
        const key = `${type}:${sessionId ?? ""}:${at}`;
        if (lastSignalKeyRef.current === key) return;
        lastSignalKeyRef.current = key;
      }
      receive({
        type,
        sessionId,
        at,
      });
    };

    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event) => readSignal(event.data);
    } catch {
      channel = undefined;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== EVENT_KEY || !event.newValue) return;
      try {
        readSignal(JSON.parse(event.newValue));
      } catch {
        // ignore malformed
      }
    };
    window.addEventListener("storage", onStorage);

    const onFocus = () => {
      if (document.visibilityState === "visible" && view === "app") {
        void refreshSession(true).catch(() => undefined);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      channel?.close();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [invalidateSessionRefresh, refreshSession, view]);

  useEffect(() => {
    const onAuthFailure = (event: Event) => {
      const status = (event as CustomEvent<{ status?: unknown }>).detail?.status;
      if (!snapshot?.authenticated || (status !== 401 && status !== 423)) return;
      invalidateSessionRefresh();
      void refreshSession(status === 401).catch(() => undefined);
    };
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, onAuthFailure);
    return () => window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, onAuthFailure);
  }, [invalidateSessionRefresh, refreshSession, snapshot?.authenticated]);

  const lockSession = useCallback(async () => {
    if (
      !snapshot?.authenticated ||
      snapshot.security.status !== "ACTIVE" ||
      !snapshot.session.pinConfigured ||
      snapshot.session.locked
    )
      return;
    const endMutation = beginSessionMutation();
    try {
      await adminRequest("/security/pin/lock", {});
      endMutation();
      signal("locked", snapshot.session.id);
      await refreshSession(false);
    } catch {
      endMutation();
      const next = await refreshSession(false).catch(() => null);
      if (next?.authenticated && next.session.locked) signal("locked", next.session.id);
    }
  }, [beginSessionMutation, refreshSession, snapshot]);

  useIdleLock(
    Boolean(
      snapshot?.authenticated &&
        view === "app" &&
        snapshot.security.status === "ACTIVE" &&
        snapshot.session.pinConfigured &&
        !snapshot.session.locked
    ),
    idleMinutes,
    snapshot?.authenticated ? snapshot.session.id : undefined,
    () => void lockSession()
  );

  const toggleTheme = () => setTheme((c) => (c === "dark" ? "light" : "dark"));

  const signOut = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const endMutation = beginSessionMutation();
    try {
      await adminRequest("/auth/sign-out", {});
      endMutation();
    } catch (failure) {
      endMutation();
      const next = await refreshSession(false).catch(() => null);
      if (!next || next.authenticated) {
        setError(failure instanceof AdminApiError && failure.code === "NETWORK_ERROR" ? "网络暂时不可用，当前会话未退出。" : friendlyError(failure));
        return;
      }
    }
    signal("logout", sessionId);
    clearTabs();
    if (`${window.location.pathname}${window.location.search}` !== "/") {
      window.history.replaceState(null, "", "/");
    }
    setSnapshot({ authenticated: false });
    setView("login");
    setPassword("");
    setTotpURI(undefined);
    setBackupCodes([]);
    setRecoveryNotice(undefined);
  }, [beginSessionMutation, refreshSession]);

  const login = async (idValue: string, pwValue: string) => {
    setError(undefined);
    setRecoveryNotice(undefined);
    setTotpURI(undefined);
    setBackupCodes([]);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      const isEmail = idValue.includes("@");
      const result = await adminRequest<AuthResponse>(
        isEmail ? "/auth/sign-in" : "/auth/sign-in/username",
        isEmail ? { email: idValue, password: pwValue } : { username: idValue, password: pwValue }
      );
      setPassword(pwValue);
      if (result.twoFactorRedirect) {
        setView("challenge");
      } else {
        endMutation();
        await refreshSession(true);
      }
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const verifyChallenge = async (method: "totp" | "backup", code: string) => {
    setError(undefined);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      await adminRequest(`/auth/two-factor/verify-${method === "totp" ? "totp" : "backup-code"}`, {
        code,
      });
      setPassword("");
      endMutation();
      await refreshSession(true);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const changePassword = async (current: string, next: string) => {
    setError(undefined);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      await adminRequest("/auth/change-password", {
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      setPassword(next);
      endMutation();
      await refreshSession(false);
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const enable2FA = async (pw: string) => {
    setError(undefined);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      const result = await adminRequest<EnrollmentResponse>("/auth/two-factor/enable", {
        password: pw || password,
      });
      setTotpURI(result.totpURI);
      setBackupCodes(result.backupCodes ?? []);
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const verify2FA = async (code: string) => {
    setError(undefined);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      await adminRequest("/auth/two-factor/verify-totp", { code });
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const activateEnrollment = async () => {
    setError(undefined);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      await adminRequest("/security/enrollment/activate", {});
      endMutation();
      await refreshSession(false);
    } catch (failure) {
      setError(friendlyError(failure));
      throw failure;
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const unlock = async (body: Record<string, unknown>) => {
    setLockError(undefined);
    setLoading(true);
    const endMutation = beginSessionMutation();
    try {
      await adminRequest("/security/pin/unlock", body);
      endMutation();
      signal("unlocked", sessionIdRef.current);
      await refreshSession(false);
    } catch (failure) {
      setLockError(friendlyError(failure));
    } finally {
      endMutation();
      setLoading(false);
    }
  };

  const setIdle = (value: number) => {
    if (![5, 15, 30, 60].includes(value)) return;
    setIdleMinutes(value);
    try {
      window.localStorage.setItem(IDLE_KEY, String(value));
    } catch {
      // local preference optional
    }
  };

  if (!snapshot) {
    return (
      <div className="loading-screen">
        <BrandLogo variant="horizontal" height={36} />
        <span className="text-xs font-mono">正在读取管理会话…</span>
      </div>
    );
  }

  // 1. Routine Login
  if (view === "login") {
    return (
      <AuthLayout theme={theme} onToggleTheme={toggleTheme}>
        <LoginView
          identifier={identifier}
          loading={loading}
          error={error}
          onIdentifier={setIdentifier}
          onSubmit={login}
          onRecovery={() => {
            setError(undefined);
            setView("recovery");
          }}
        />
      </AuthLayout>
    );
  }

  // 2. 2FA Challenge
  if (view === "challenge") {
    return (
      <AuthLayout
        theme={theme}
        onToggleTheme={toggleTheme}


      >
        <ChallengeView
          loading={loading}
          error={error}
          onSubmit={verifyChallenge}
          onBack={() => {
            setError(undefined);
            setView("login");
          }}
          onRecovery={() => {
            setError(undefined);
            setView("recovery");
          }}
        />
      </AuthLayout>
    );
  }

  // 3. Onboarding (First-time initialization)
  if (view === "onboarding") {
    const needsPasswordChange = snapshot.authenticated && snapshot.security.passwordChangeRequired;

    // Determine initial step
    const initialStep = needsPasswordChange ? 1 : 2;
    const accountName = snapshot.authenticated
      ? snapshot.user.displayUsername || snapshot.user.username || identifier
      : identifier;

    return (
      <AuthLayout
        theme={theme}
        onToggleTheme={toggleTheme}
        variant="onboarding"


      >
        <OnboardingView
          accountIdentifier={accountName}
          initialStep={initialStep}
          loading={loading}
          error={error}
          cachedPassword={password}
          totpURI={totpURI}
          backupCodes={backupCodes}
          onChangePassword={changePassword}
          onEnable2FA={enable2FA}
          onVerify2FA={verify2FA}
          onActivateEnrollment={activateEnrollment}
          onComplete={async () => {
            const next = await refreshSession(true);
            if (next.authenticated) { setPassword(""); setTotpURI(undefined); setBackupCodes([]); setView("app"); }
          }}
        />
      </AuthLayout>
    );
  }

  // 4. Standalone Recovery
  if (view === "recovery") {
    return (
      <AuthLayout
        theme={theme}
        onToggleTheme={toggleTheme}


      >
        <RecoveryView
          snapshot={snapshot?.authenticated ? snapshot : undefined}
          initialMessage={recoveryNotice}
          onBack={() => {
            setError(undefined);
            setView("login");
          }}
          onCompleted={() => {
            invalidateSessionRefresh();
            if (sessionIdRef.current) signal("logout", sessionIdRef.current);
            setSnapshot({ authenticated: false });
            setRecoveryNotice("恢复已完成。请使用新密码登录并绑定身份验证器。");
          }}
        />
      </AuthLayout>
    );
  }

  // 5. Authenticated App Shell & Workspace
  if (!snapshot.authenticated) {
    return (
      <AuthLayout theme={theme} onToggleTheme={toggleTheme}>
        <LoginView
          identifier={identifier}
          loading={loading}
          error={error}
          onIdentifier={setIdentifier}
          onSubmit={login}
          onRecovery={() => setView("recovery")}
        />
      </AuthLayout>
    );
  }

  return (
    <div className="admin-app">
      <div ref={shellRef} className="app-shell">
        <WorkspaceApp
          snapshot={snapshot}
          theme={theme}
          onToggleTheme={toggleTheme}
          idleMinutes={idleMinutes}
          onIdleMinutes={setIdle}
          onLock={() => void lockSession()}
          onSignOut={() => void signOut()}
          onRefresh={refreshSession}
          onRecoveryCompleted={() => {
            void refreshSession(true);
          }}
        />
      </div>
      {snapshot.session.locked && (
        <LockScreen
          mobile={mobile}
          loading={loading}
          error={lockError}
          onUnlock={(body) => void unlock(body)}
          onSignOut={() => void signOut()}
        />
      )}
    </div>
  );
}

const initialTheme = (() => {
  if (typeof window !== "undefined") {
    const urlTheme = new URLSearchParams(window.location.search).get("theme");
    if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
    if (window.localStorage.getItem("zzsh-admin-theme") === "light") return "light";
  }
  return "dark";
})();

if (typeof document !== "undefined") {
  document.documentElement.dataset.theme = initialTheme;
  document.documentElement.classList.toggle("dark", initialTheme === "dark");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
