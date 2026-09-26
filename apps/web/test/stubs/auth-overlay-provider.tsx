import { createContext, useContext, type ReactNode } from "react";

type AuthOverlayApi = { open: (target?: string, onSuccess?: () => void) => void };

const AuthOverlayContext = createContext<AuthOverlayApi | null>(null);

/** Preview/behavior 测试桩：不打开真实登录弹窗，只占位避免组件缺 Provider。 */
export function AuthOverlayProvider({ children }: { children: ReactNode }) {
  return <AuthOverlayContext.Provider value={{ open: () => {} }}>{children}</AuthOverlayContext.Provider>;
}

export function useAuthOverlay(): AuthOverlayApi {
  const value = useContext(AuthOverlayContext);
  if (!value) throw new Error("AuthOverlayProvider is required");
  return value;
}
