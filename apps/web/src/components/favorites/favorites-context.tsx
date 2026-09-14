"use client";
import { useUserSessionStore } from "../session/user-session-provider";
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
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { X } from "lucide-react";
import { supplyApi } from "@/lib/supply-client";
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
  const storeRef = useRef<FavoritesStore | null>(null);
  if (!storeRef.current) storeRef.current = createBrowserStore();
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [loginHref, setLoginHref] = useState("/login");
  const [loginOpen, setLoginOpen] = useState(false);
  const loginReturnFocus = useRef<HTMLElement | null>(null);

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

  const openLogin = useCallback(() => {
    const current = window.location.pathname + window.location.search;
    setLoginHref("/login?next=" + encodeURIComponent(current));
    loginReturnFocus.current = document.activeElement as HTMLElement | null;
    setLoginOpen(true);
  }, []);

  const toggle = useCallback(
    async (accountId: string, next: boolean) => {
      if (snapshot.status === "guest") {
        openLogin();
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
      <Dialog.Root open={loginOpen} onOpenChange={setLoginOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="feedback-dialog login-prompt"
            onCloseAutoFocus={(event) => {
              if (loginReturnFocus.current?.isConnected) {
                event.preventDefault();
                loginReturnFocus.current.focus();
              }
            }}>
            <Dialog.Title>登录后即可收藏</Dialog.Title>
            <Dialog.Description>
              收藏保存在服务端账号中。登录后会回到当前页面，继续浏览与收藏。
            </Dialog.Description>
            <Dialog.Close className="icon-button dialog-close" aria-label="关闭登录提示">
              <X size={20} />
            </Dialog.Close>
            <div className="login-prompt-actions">
              <Dialog.Close asChild>
                <Link className="button primary" href={loginHref}>
                  登录 / 注册
                </Link>
              </Dialog.Close>
              <Dialog.Close asChild>
                <button className="button secondary" type="button">
                  继续浏览
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </FavoritesContext.Provider>
  );
}
