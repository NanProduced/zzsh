"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { UserSessionStore, type UserSessionSnapshot, type UserSessionStatus } from "@/lib/user-session-store";
import {
  USER_SESSION_CHANNEL,
  createBrowserUserSessionStore,
  performSignOut,
  publishUserSessionChange,
} from "@/lib/user-session-client";

export { USER_SESSION_CHANNEL, publishUserSessionChange };

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

  return <UserSessionStoreContext.Provider value={store}><UserSessionContext.Provider value={api}>{children}</UserSessionContext.Provider></UserSessionStoreContext.Provider>;
}
