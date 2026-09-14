import { favoriteFailureText, newFavoriteKey } from "./favorites.ts";

export type FavoritesIdentityStatus = "loading" | "guest" | "authenticated" | "error";
export type FavoriteStatus = "unknown" | "saved" | "unsaved" | "pending";
export type FavoritesNotice = { text: string; retryAccountId: string | null };
export type FavoritesSnapshot = {
  status: FavoritesIdentityStatus;
  userId: string | null;
  generation: number;
  saved: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  complete: boolean;
  notice: FavoritesNotice | null;
};
export type FavoritesSessionResult = { userId: string | null };
export type FavoritesPageResult = { accountIds: string[]; nextCursor: string | null };
export interface FavoritesStoreTransport {
  session(signal: AbortSignal): Promise<FavoritesSessionResult>;
  favoritesPage(cursor: string | null, signal: AbortSignal): Promise<FavoritesPageResult>;
  setFavorite(accountId: string, saved: boolean, key: string): Promise<void>;
}
type Attempt = { key: string; saved: boolean };

// ponytail: page through the existing paginated endpoint; the safety bound only stops runaway loops.
const MAX_LOAD_PAGES = 50;

export class FavoritesStore {
  #transport: FavoritesStoreTransport;
  #listeners = new Set<() => void>();
  #status: FavoritesIdentityStatus = "loading";
  #userId: string | null = null;
  // Read generation: bumped on every confirmation; older read responses are discarded.
  #generation = 0;
  // Identity version: bumped only when the confirmed user actually changes; in-flight writes
  // from the previous identity are discarded, while same-user refreshes keep them alive.
  #identityVersion = 0;
  #saved = new Set<string>();
  #pending = new Set<string>();
  #complete = false;
  #notice: FavoritesNotice | null = null;
  #attempts = new Map<string, Attempt>();
  #mutations = new Map<string, number>();
  #seq = 0;
  // Records the favorites page fetched from the server, used as saved evidence when the
  // background list read is incomplete. Local operations override them.
  #basis = new Set<string>();
  #overrides = new Map<string, boolean>();
  #readAbort: AbortController | null = null;
  // Read sequence: bumped on every list read so a superseded reload (same identity, no new
  // generation) cannot overwrite a newer read's result.
  #readSeq = 0;
  #snapshot: FavoritesSnapshot;

  constructor(transport: FavoritesStoreTransport) {
    this.#transport = transport;
    this.#snapshot = this.#buildSnapshot();
  }
  #buildSnapshot(): FavoritesSnapshot {
    const authenticated = this.#status === "authenticated";
    return {
      status: this.#status,
      userId: this.#userId,
      generation: this.#generation,
      // Private state is only exposed for a confirmed identity.
      saved: authenticated ? new Set(this.#saved) : new Set(),
      pending: authenticated ? new Set(this.#pending) : new Set(),
      complete: authenticated ? this.#complete : false,
      notice: this.#notice,
    };
  }
  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): FavoritesSnapshot => this.#snapshot;
  #bumpMutation(accountId: string): void {
    this.#mutations.set(accountId, ++this.#seq);
  }
  #adoptIdentity(userId: string | null): void {
    this.#identityVersion += 1;
    this.#userId = userId;
    this.#saved = new Set();
    this.#pending = new Set();
    this.#complete = false;
    this.#attempts.clear();
    this.#mutations.clear();
    this.#basis.clear();
    this.#overrides.clear();
  }
  #resolvedSaved(accountId: string): boolean | undefined {
    if (this.#overrides.has(accountId)) return this.#overrides.get(accountId);
    if (this.#saved.has(accountId)) return true;
    if (this.#basis.has(accountId)) return true;
    if (this.#complete) return false;
    return undefined;
  }

  // A confirmation refresh never discards same-identity in-flight writes: private state is
  // hidden while the session is unconfirmed, and the identity/version pair is only replaced
  // when the session actually resolves to a different user.
  suspendIdentity(status: "loading" | "error"): void {
    this.#generation += 1;
    this.#readSeq += 1;
    this.#readAbort?.abort();
    this.#status = status;
    this.#notice = null;
    this.#emit();
  }

  async confirmIdentity(confirmed?: FavoritesSessionResult): Promise<void> {
    const generation = ++this.#generation;
    this.#readAbort?.abort();
    const controller = new AbortController();
    this.#readAbort = controller;
    const read = ++this.#readSeq;
    const previousUserId = this.#userId;
    this.#status = "loading";
    this.#notice = null;
    this.#emit();
    let session: FavoritesSessionResult;
    try {
      session = confirmed ?? await this.#transport.session(controller.signal);
    } catch {
      if (generation !== this.#generation) return;
      this.#status = "error";
      this.#emit();
      return;
    }
    if (generation !== this.#generation) return;
    if (session.userId !== previousUserId) this.#adoptIdentity(session.userId);
    if (!session.userId) {
      this.#status = "guest";
      this.#emit();
      return;
    }
    this.#status = "authenticated";
    this.#emit();
    await this.#loadFavorites(generation, read, controller.signal);
  }

  // Re-reads the favorites list for the current identity without re-confirming the session.
  async reloadFavorites(): Promise<void> {
    if (this.#status !== "authenticated") return;
    const generation = this.#generation;
    this.#readAbort?.abort();
    const controller = new AbortController();
    this.#readAbort = controller;
    const read = ++this.#readSeq;
    await this.#loadFavorites(generation, read, controller.signal);
  }

  async #loadFavorites(generation: number, read: number, signal: AbortSignal): Promise<void> {
    const startSeq = this.#seq;
    const loaded = new Set<string>();
    let complete = false;
    let cursor: string | null = null;
    let pages = 0;
    // A read is stale once the identity is re-confirmed (generation), a newer read is issued
    // (readSeq) or this request is aborted; stale pages never touch current state.
    const stale = () => generation !== this.#generation || read !== this.#readSeq || signal.aborted;
    try {
      for (;;) {
        const page = await this.#transport.favoritesPage(cursor, signal);
        if (stale()) return;
        for (const accountId of page.accountIds) loaded.add(accountId);
        pages += 1;
        if (!page.nextCursor) {
          complete = true;
          break;
        }
        if (pages >= MAX_LOAD_PAGES) break;
        cursor = page.nextCursor;
      }
    } catch {
      if (stale()) return;
      complete = false;
    }
    if (stale()) return;
    // Only a complete authoritative snapshot supersedes a settled local operation; a failed or
    // partial read must keep its override so a successful cancel is not resurrected.
    if (complete) {
      for (const [accountId, seq] of this.#mutations) {
        if (seq <= startSeq && !this.#pending.has(accountId)) this.#overrides.delete(accountId);
      }
    }
    // A complete read is authoritative; an incomplete one keeps previously known entries.
    const merged = complete ? new Set(loaded) : new Set([...loaded, ...this.#saved]);
    for (const [accountId, seq] of this.#mutations) {
      if (seq <= startSeq && !this.#pending.has(accountId)) continue;
      if (this.#saved.has(accountId)) merged.add(accountId);
      else merged.delete(accountId);
    }
    this.#saved = merged;
    this.#complete = complete;
    if (complete) this.#basis.clear();
    this.#emit();
  }

  // Favorites page records are saved evidence for their account until a local operation or a
  // complete background read replaces that knowledge.
  registerSavedRecords(accountIds: readonly string[]): void {
    if (this.#status !== "authenticated") return;
    let changed = false;
    for (const accountId of accountIds) {
      if (this.#saved.has(accountId) || this.#basis.has(accountId)) continue;
      this.#basis.add(accountId);
      changed = true;
    }
    if (changed) this.#emit();
  }

  statusOf(accountId: string): FavoriteStatus {
    if (this.#pending.has(accountId)) return "pending";
    if (this.#status !== "authenticated") return "unknown";
    const resolved = this.#resolvedSaved(accountId);
    if (resolved === undefined) return "unknown";
    return resolved ? "saved" : "unsaved";
  }

  // Duplicate clicks while a write is pending are ignored; the button reports pending/busy.
  async toggle(accountId: string, next: boolean): Promise<void> {
    if (this.#status !== "authenticated") throw new Error("identity-unavailable");
    if (this.#pending.has(accountId)) return;
    await this.#perform(accountId, next);
  }

  async #perform(accountId: string, next: boolean): Promise<void> {
    const version = this.#identityVersion;
    const userId = this.#userId;
    const existing = this.#attempts.get(accountId);
    const key = existing && existing.saved === next ? existing.key : newFavoriteKey();
    this.#attempts.set(accountId, { key, saved: next });
    const previous = this.#resolvedSaved(accountId);
    this.#pending.add(accountId);
    this.#bumpMutation(accountId);
    this.#notice = null;
    this.#overrides.set(accountId, next);
    if (next) this.#saved.add(accountId);
    else this.#saved.delete(accountId);
    this.#emit();
    try {
      await this.#transport.setFavorite(accountId, next, key);
      if (version !== this.#identityVersion || userId !== this.#userId) return;
      this.#attempts.delete(accountId);
      this.#pending.delete(accountId);
      this.#bumpMutation(accountId);
      // The confirmed result is re-applied even if a refresh cleared the optimistic display.
      this.#overrides.set(accountId, next);
      if (next) this.#saved.add(accountId);
      else this.#saved.delete(accountId);
      this.#emit();
    } catch (error) {
      if (version !== this.#identityVersion || userId !== this.#userId) return;
      if (previous === undefined) this.#overrides.delete(accountId);
      else this.#overrides.set(accountId, previous);
      if (previous === true) this.#saved.add(accountId);
      else this.#saved.delete(accountId);
      this.#pending.delete(accountId);
      this.#bumpMutation(accountId);
      const status = (error as { status?: number }).status;
      if (status === 401) {
        this.#adoptIdentity(null);
        this.#status = "guest";
        this.#notice = { text: favoriteFailureText(error, next), retryAccountId: null };
        this.#emit();
        throw error;
      }
      this.#notice = { text: favoriteFailureText(error, next), retryAccountId: accountId };
      this.#emit();
      throw error;
    }
  }

  async retry(): Promise<void> {
    const accountId = this.#notice?.retryAccountId;
    if (!accountId) return;
    if (this.#status !== "authenticated") return;
    const attempt = this.#attempts.get(accountId);
    if (!attempt) return;
    if (this.#pending.has(accountId)) return;
    try {
      await this.#perform(accountId, attempt.saved);
    } catch {
      // The failure notice is already updated by #perform.
    }
  }

  dismissNotice(): void {
    if (!this.#notice) return;
    this.#notice = null;
    this.#emit();
  }

  dispose(): void {
    this.#generation += 1;
    this.#readSeq += 1;
    this.#readAbort?.abort();
    this.#listeners.clear();
  }
}
