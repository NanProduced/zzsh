import { createContext, useContext, type ReactNode } from "react";

type SessionStatus = "loading" | "guest" | "authenticated" | "error";

type SessionApi = {
  status: SessionStatus;
  userId: string | null;
  displayName: string | null;
  identityVersion: number;
  revision: number;
  confirm: () => Promise<SessionStatus | "superseded">;
  revalidate: () => void;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionApi | null>(null);

const previewSession: SessionApi = {
  status: "authenticated",
  userId: "preview-user",
  displayName: "演示用户",
  identityVersion: 1,
  revision: 1,
  confirm: async () => "authenticated",
  revalidate: () => {},
  signOut: async () => {},
};

/** Preview/behavior 测试桩：不发网络请求，只提供稳定的已登录会话形状。 */
export function UserSessionProvider({ children }: { children: ReactNode }) {
  return <SessionContext.Provider value={previewSession}>{children}</SessionContext.Provider>;
}

export function useUserSession(): SessionApi {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useUserSession requires UserSessionProvider");
  return value;
}
