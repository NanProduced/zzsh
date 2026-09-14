export type UserSessionStatus = "loading" | "guest" | "authenticated" | "error";

export type UserSessionSnapshot = {
  status: UserSessionStatus;
  /** Confirmed user id; private identity fields are null while unconfirmed. */
  userId: string | null;
  /** Presentation name of the confirmed user (never a guest placeholder). */
  displayName: string | null;
  /** Bumped only when the confirmed user actually changes; same-user refresh keeps it. */
  identityVersion: number;
  /** Bumped on every state transition, including re-confirmation of the same user. */
  revision: number;
};

export type UserSessionResult = { userId: string | null; displayName?: string | null };
export interface UserSessionTransport {
  session(signal: AbortSignal): Promise<UserSessionResult>;
}

/**
 * Shared user session state for the portal.
 *
 * - `loading`/`error` are distinct from `guest`: consumers must not render private content or
 *   claim the visitor is logged out while the server has not confirmed the session.
 * - The confirmed identity is only exposed while `authenticated`. Re-confirmation hides it but
 *   keeps the internal confirmed value, so a same-user refresh bumps `revision` only, while a
 *   real identity switch also bumps `identityVersion` and lets consumers discard stale data.
 * - Every confirmation has a request generation; late responses from a superseded request are
 *   discarded instead of restoring an older identity.
 */
export class UserSessionStore {
  #transport: UserSessionTransport;
  #listeners = new Set<() => void>();
  #status: UserSessionStatus = "loading";
  #userId: string | null = null;
  #confirmedUserId: string | null = null;
  #displayName: string | null = null;
  #identityVersion = 0;
  #revision = 0;
  #requestSeq = 0;
  #abort: AbortController | null = null;
  #snapshot: UserSessionSnapshot;

  constructor(transport: UserSessionTransport) {
    this.#transport = transport;
    this.#snapshot = this.#buildSnapshot();
  }

  #buildSnapshot(): UserSessionSnapshot {
    const authenticated = this.#status === "authenticated";
    return {
      status: this.#status,
      userId: authenticated ? this.#userId : null,
      displayName: authenticated ? this.#displayName : null,
      identityVersion: this.#identityVersion,
      revision: this.#revision,
    };
  }

  #emit(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): UserSessionSnapshot => this.#snapshot;

  /**
   * Re-reads the server session. Resolves with the status this call settled on, or
   * "superseded" when a newer confirmation replaced it; callers must not treat a
   * superseded read as a settled server fact.
   */
  async confirm(): Promise<UserSessionStatus | "superseded"> {
    const seq = ++this.#requestSeq;
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;
    this.#status = "loading";
    this.#userId = null;
    this.#displayName = null;
    this.#emit();
    let result: UserSessionResult;
    try {
      result = await this.#transport.session(controller.signal);
    } catch {
      if (seq !== this.#requestSeq) return "superseded";
      this.#status = "error";
      this.#emit();
      return "error";
    }
    if (seq !== this.#requestSeq) return "superseded";
    if (result.userId !== this.#confirmedUserId) {
      this.#confirmedUserId = result.userId;
      this.#identityVersion += 1;
    }
    this.#userId = result.userId;
    this.#displayName = result.displayName ?? null;
    this.#status = result.userId ? "authenticated" : "guest";
    this.#emit();
    return this.#status;
  }

  dispose(): void {
    this.#requestSeq += 1;
    this.#abort?.abort();
    this.#listeners.clear();
  }
}
