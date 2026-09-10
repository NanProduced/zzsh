export const API_ROOT = "/api/bff/admin";
export const CHANNEL_NAME = "zzsh-admin-security";
export const EVENT_KEY = `${CHANNEL_NAME}:event`;
export const IDLE_KEY = "zzsh-admin-idle-minutes";

export type Theme = "dark" | "light";
export type View = "login" | "challenge" | "onboarding" | "recovery" | "app";
export type Signal = "locked" | "unlocked" | "logout" | "activity";
export type SignalEvent = { type: Signal; sessionId?: string; at: number };

export type SessionSnapshot =
  | { authenticated: false }
  | {
      authenticated: true;
      adminUserId: string;
      user: { name?: string; email?: string; username?: string; displayUsername?: string; twoFactorEnabled: boolean };
      security: { status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN"; isBoss: boolean; passwordChangeRequired: boolean };
      session: { id: string; locked: boolean; pinConfigured: boolean; createdAt: string | null; expiresAt: string | null };
    };

export type AuthResponse = { twoFactorRedirect?: boolean };
export type EnrollmentResponse = { totpURI?: string; backupCodes?: string[] };
export type RecoveryResponse = { recoveryRequestId?: string; status?: string; target?: { username?: string; name?: string } };
export type AdminDirectoryEntry = { id: string; username: string; name: string; status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN" };
export type PendingRecovery = { id: string; username: string; name: string; status: string; createdAt: string; expiresAt: string };

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly requestId?: string) {
    super(code);
    this.name = "AdminApiError";
  }
}

export async function adminRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AdminApiError(0, "NETWORK_ERROR");
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: string; requestId?: string } }).error
      : undefined;
    throw new AdminApiError(response.status, error?.code ?? "INTERNAL_ERROR", error?.requestId);
  }
  return payload as T;
}

export function friendlyError(error: unknown): string {
  if (!(error instanceof AdminApiError) || error.code === "NETWORK_ERROR") return "网络暂时不可用，请检查 API 是否已启动后重试。";
  if (error.status === 423) return "本次会话已锁定，请使用 PIN 或完整重新认证继续。";
  if (error.code === "RATE_LIMITED") return "尝试次数过多，请稍后再试。";
  if (error.code === "CONFLICT") return "当前安全状态不允许此操作，请刷新状态后重试。";
  if (error.code === "FORBIDDEN") return "当前账号没有完成此操作所需的安全条件。";
  if (error.code === "UNAUTHENTICATED") return "账号或密码错误，请检查凭据后重试。";
  if (error.code === "INVALID_CREDENTIALS") return "验证码或凭据无效，请重新输入。";
  if (error.code === "INVALID_PASSWORD") return "当前密码错误，请重新输入。";
  if (error.code === "PASSWORD_TOO_WEAK") return "新密码强度不足，请至少输入 12 位字符。";
  if (error.code === "TWO_FACTOR_REQUIRED") return "需要完成二次验证方可继续。";
  return "操作未完成，请检查输入或刷新页面后重试。";
}

export function formatDate(value: string | null): string {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function readTotpSecret(uri: string): string {
  try { return new URL(uri).searchParams.get("secret") ?? ""; } catch { return ""; }
}

export function readIdleMinutes(): number {
  if (typeof window === "undefined") return 15;
  const value = Number(window.localStorage.getItem(IDLE_KEY));
  return [5, 15, 30, 60].includes(value) ? value : 15;
}

export function signal(type: Signal, sessionId?: string, at = Date.now()): void {
  const event = { type, sessionId, at } satisfies SignalEvent;
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(event);
    channel.close();
  } catch {
    // BroadcastChannel is an enhancement; the storage event below is fallback.
  }
  try { window.localStorage.setItem(EVENT_KEY, JSON.stringify(event)); } catch {
    // Storage fallback.
  }
}

export function makeRecoveryCredential(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
