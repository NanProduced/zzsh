"use client";
import { useUserSessionStore } from "../session/user-session-provider";
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
import { supplyApi } from "@/lib/supply-client";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import {
  FavoritesStore,
  type FavoriteStatus,
  type FavoritesSnapshot,
} from "@/lib/favorites-store";

export type SessionState = FavoritesSnapshot["status"];
export type { FavoriteStatus };
type FavoritesApi = {
  snapshot: FavoritesSnapshot;
  statusOf: (accountId: string) => FavoriteStatus;
  toggle: (accountId: string, next: boolean) => Promise<void>;
  retry: () => void;
  reload: () => void;
  refresh: () => void;
  registerSavedRecords: (accountIds: readonly string[]) => void;
  notice: FavoritesSnapshot["notice"];
  dismissNotice: () => void;
};

const FavoritesContext = createContext<FavoritesApi | null>(null);
export function useFavorites(): FavoritesApi | null {
  return useContext(FavoritesContext);
}

function createBrowserStore(): FavoritesStore {
  return new FavoritesStore({
    session: async () => { throw new Error("Shared identity confirmation required"); },
    favoritesPage: async (cursor, signal) => {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await supplyApi.favorites(query, signal);
      return { accountIds: page.items.map((item) => item.accountId), nextCursor: page.nextCursor };
    },
    setFavorite: (accountId, saved, key) =>
      supplyApi.setFavorite(accountId, saved, key).then(() => undefined),
  });
}

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const sharedSession = useUserSessionStore();
  const authOverlay = useAuthOverlay();
  const storeRef = useRef<FavoritesStore | null>(null);
  if (!storeRef.current) storeRef.current = createBrowserStore();
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    const refresh = () => {
      const identity = sharedSession.getSnapshot();
      if (identity.status === "loading" || identity.status === "error") {
        store.suspendIdentity(identity.status);
      } else {
        void store.confirmIdentity({ userId: identity.userId });
      }
    };
    const unsubscribe = sharedSession.subscribe(refresh);
    refresh();
    return () => { unsubscribe(); store.dispose(); };
  }, [store, sharedSession]);

  const openLogin = useCallback((accountId: string, next: boolean) => {
    const current = window.location.pathname + window.location.search;
    authOverlay.open(current, () => store.toggle(accountId, next));
  }, [authOverlay, store]);

  const toggle = useCallback(
    async (accountId: string, next: boolean) => {
      if (snapshot.status === "guest") {
        openLogin(accountId, next);
        return;
      }
      if (snapshot.status !== "authenticated") return;
      await store.toggle(accountId, next);
    },
    [snapshot.status, store, openLogin],
  );
  const value = useMemo<FavoritesApi>(
    () => ({
      snapshot,
      statusOf: (accountId) => store.statusOf(accountId),
      toggle,
      retry: () => void store.retry(),
      reload: () => void sharedSession.confirm(),
      refresh: () => void store.reloadFavorites(),
      registerSavedRecords: (accountIds) => store.registerSavedRecords(accountIds),
      notice: snapshot.notice,
      dismissNotice: () => store.dismissNotice(),
    }),
    [snapshot, store, toggle, sharedSession],
  );

  return (
    <FavoritesContext.Provider value={value}>
      {children}
    </FavoritesContext.Provider>
  );
}
