"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CheckCircle2, X } from 'lucide-react';
import { UserSessionStore, type UserSessionSnapshot, type UserSessionStatus } from "@/lib/user-session-store";
import {
  USER_SESSION_CHANNEL,
  createBrowserUserSessionStore,
  performSignOut,
  publishUserSessionChange,
} from "@/lib/user-session-client";
import { registerOrderExpectedUserId } from "@/lib/order-subject";

export { USER_SESSION_CHANNEL, publishUserSessionChange };
const PROFILE_NOTICE = 'zzsh-profile-update-notice';
export function publishProfileUpdateNotice(userId: string, kind: 'avatar' | 'nickname'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PROFILE_NOTICE, { detail: { userId, kind } }));
}
export function dismissProfileUpdateNotice(userId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PROFILE_NOTICE, { detail: { userId, kind: null } }));
}

export type UserSessionApi = UserSessionSnapshot & {
  /** Re-reads the server session; a client broadcast only triggers this, never replaces it. */
  revalidate: () => void;
  /** Re-reads and resolves only with the server-confirmed state for this request. */
  confirm: () => Promise<UserSessionStatus | "superseded">;
  /** Resolves only when the server confirmation settles as guest; rejects for authenticated/error/superseded. */
  signOut: () => Promise<void>;
};

const UserSessionStoreContext = createContext<UserSessionStore | null>(null);

export function useUserSessionStore(): UserSessionStore {
  const store = useContext(UserSessionStoreContext);
  if (!store) throw new Error("UserSessionProvider is required");
  return store;
}

const UserSessionContext = createContext<UserSessionApi | null>(null);

export function useUserSession(): UserSessionApi {
  const api = useContext(UserSessionContext);
  if (!api) throw new Error("useUserSession requires UserSessionProvider");
  return api;
}

export function UserSessionProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<UserSessionStore | null>(null);
  if (!storeRef.current) storeRef.current = createBrowserUserSessionStore();
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Register synchronously during render: child order components may issue their first request
  // from an effect, and child effects run before parent effects. Re-validation temporarily sets
  // status to "loading" with a null userId, so keep the last confirmed subject in that window;
  // only a confirmed guest transition clears it.
  if (snapshot.status === "authenticated" && snapshot.userId) {
    registerOrderExpectedUserId(snapshot.userId);
  } else if (snapshot.status === "guest") {
    registerOrderExpectedUserId(null);
  }
  const [profileNotice, setProfileNotice] = useState<{ userId: string; kind: 'avatar' | 'nickname' } | null>(null);
  useEffect(() => {
    const show = (event: Event) => {
      const value = (event as CustomEvent).detail, current = store.getSnapshot();
      if (current.status === 'authenticated' && value?.userId === current.userId) {
        if (value.kind === null) setProfileNotice(null);
        else if (value.kind === 'avatar' || value.kind === 'nickname') setProfileNotice({ userId: value.userId, kind: value.kind });
      }
    };
    window.addEventListener(PROFILE_NOTICE, show); return () => window.removeEventListener(PROFILE_NOTICE, show);
  }, [store]);
  useEffect(() => { if (!profileNotice) return; const timer = setTimeout(() => setProfileNotice(null), 6000); return () => clearTimeout(timer); }, [profileNotice]);
  useEffect(() => { if (snapshot.status === 'guest' || snapshot.status === 'authenticated' && profileNotice && snapshot.userId !== profileNotice.userId) setProfileNotice(null); }, [snapshot.status, snapshot.userId, profileNotice]);
  const showProfileNotice = profileNotice && (snapshot.status === 'loading' || snapshot.status === 'error' || snapshot.status === 'authenticated' && snapshot.userId === profileNotice.userId);

  useEffect(() => {
    const revalidate = () => { void store.confirm(); };
    revalidate();
    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let channel: BroadcastChannel | undefined;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(USER_SESSION_CHANNEL);
      channel.onmessage = revalidate;
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      channel?.close();
      store.dispose();
    };
  }, [store]);

  const signOut = useCallback(() => performSignOut(store), [store]);
  const confirm = useCallback(() => store.confirm(), [store]);

  const api = useMemo<UserSessionApi>(() => ({
    ...snapshot,
    revalidate: () => { void store.confirm(); },
    confirm,
    signOut,
  }), [snapshot, confirm, signOut]);

  return <UserSessionStoreContext.Provider value={store}><UserSessionContext.Provider value={api}>{children}{showProfileNotice ? <div className="profile-change-toast" role="status"><CheckCircle2 size={18} aria-hidden/><span>{profileNotice.kind === 'avatar' ? '头像已更新' : '昵称已更新'}</span><button type="button" aria-label="关闭资料更新提示" onClick={() => setProfileNotice(null)}><X size={16}/></button></div> : null}</UserSessionContext.Provider></UserSessionStoreContext.Provider>;
}
