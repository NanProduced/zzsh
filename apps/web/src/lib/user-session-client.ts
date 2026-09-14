import { UserSessionStore } from "./user-session-store.ts";

export const USER_SESSION_CHANNEL = "zzsh-user-session-v1";

/** Cross-tab trigger; the receiving tab must re-confirm against the server. */
export function publishUserSessionChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(USER_SESSION_CHANNEL);
  channel.postMessage({ type: "user-session-changed" });
  channel.close();
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function readSessionUser(value: unknown): { id: string; displayName: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const user = (value as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  const id = (user as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return null;
  const name = (user as { name?: unknown }).name;
  const username = (user as { username?: unknown }).username;
  const displayName = typeof name === "string" && name.trim() ? name.trim() : typeof username === "string" && username.trim() ? username.trim() : null;
  return { id, displayName };
}

/**
 * The session read contract is exactly `null` (no session) or a user object with a non-empty id.
 * Anything else - a non-2xx response, unparseable body, empty body or a malformed shape - is a
 * confirmation failure, never a guest, so consumers do not discard a confirmed identity because
 * of a broken read.
 */
export function createBrowserUserSessionStore(fetchImpl: FetchLike = fetch): UserSessionStore {
  return new UserSessionStore({
    session: async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl("/api/auth/user/get-session", { credentials: "same-origin", cache: "no-store", signal });
      } catch {
        throw new Error("session-unavailable");
      }
      if (!response.ok) throw new Error("session-unavailable");
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error("session-unavailable");
      }
      if (data === null) return { userId: null };
      const user = readSessionUser(data);
      if (!user) throw new Error("session-unavailable");
      return { userId: user.id, displayName: user.displayName };
    },
  });
}

/** Returns false for any non-2xx response or transport failure; the caller must re-confirm. */
export async function requestSignOut(fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/auth/user/sign-out", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Full sign-out orchestration. Only the settled server confirmation decides success: a POST that
 * was accepted, rejected or lost is not the session truth, and a concurrent tab that signs in
 * again must not be reported as a completed sign-out. `guest` resolves; `authenticated`, `error`
 * and `superseded` reject so the caller can retry. The broadcast happens after this tab settled.
 */
export async function performSignOut(store: UserSessionStore, fetchImpl: FetchLike = fetch): Promise<void> {
  await requestSignOut(fetchImpl);
  const status = await store.confirm();
  publishUserSessionChange();
  if (status !== "guest") throw new Error(`sign-out-unconfirmed:${status}`);
}
