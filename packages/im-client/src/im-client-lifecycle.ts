export type ImClientHandle<T> = { client: T; dispose: () => void | Promise<void> };

export type ImClientContext = {
  identity: string;
  generation: number;
  isCurrent: () => boolean;
  onCurrent: <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args) => void;
  /** Register a real cancellation for work that is still opening (e.g. SDK login). */
  onCancel?: (callback: () => void | Promise<void>) => void;
};

export type ImClientFactory<T> = (context: ImClientContext) => ImClientHandle<T> | Promise<ImClientHandle<T>>;
export type ImClientLifecycleSnapshot = { state: "idle" | "opening" | "ready"; identity: string | null; generation: number };

export class ImLifecycleSupersededError extends Error {
  constructor() { super("IM client lifecycle operation was superseded"); this.name = "ImLifecycleSupersededError"; }
}

/** A factory marks a rejected pending open when SDK cleanup itself failed. */
export const IM_DISPOSE_FAILED = Symbol.for("zzsh.im.dispose-failed");

export function markImDisposeFailure<T extends Error>(error: T, cause?: unknown): T {
  Object.defineProperty(error, IM_DISPOSE_FAILED, { value: true, configurable: true });
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
}

export function isImDisposeFailure(value: unknown): boolean {
  return Boolean(value && (value as { [IM_DISPOSE_FAILED]?: boolean })[IM_DISPOSE_FAILED]);
}

type ActiveClient<T> = { identity: string; generation: number; handle: ImClientHandle<T> };
type PendingClient<T> = { identity: string; generation: number; promise: Promise<ImClientHandle<T>> };

function normalizeIdentity(identity: string): string {
  const value = identity.trim();
  if (!value) throw new TypeError("IM identity must not be blank");
  if (value.length > 128) throw new TypeError("IM identity must be at most 128 characters");
  return value;
}

function assertHandle<T>(handle: ImClientHandle<T>): ImClientHandle<T> {
  if (!handle || typeof handle !== "object" || typeof handle.dispose !== "function" || !("client" in handle)) throw new TypeError("IM client factory must return a client and dispose function");
  return handle;
}

export class ImClientLifecycle<T> {
  private readonly factory: ImClientFactory<T>;
  private generation = 0;
  private active: ActiveClient<T> | undefined;
  private pending: PendingClient<T> | undefined;
  private pendingCancel: (() => void | Promise<void>) | undefined;
  private disposal = Promise.resolve();
  private disposeFailure: unknown;

  constructor(factory: ImClientFactory<T>) { this.factory = factory; }

  getSnapshot(): ImClientLifecycleSnapshot {
    if (this.active) return { state: "ready", identity: this.active.identity, generation: this.active.generation };
    if (this.pending) return { state: "opening", identity: this.pending.identity, generation: this.pending.generation };
    return { state: "idle", identity: null, generation: this.generation };
  }

  open(identity: string): Promise<T> {
    if (this.disposeFailure) return Promise.reject(this.disposeFailure);
    const normalized = normalizeIdentity(identity);
    if (this.active?.identity === normalized) return Promise.resolve(this.active.handle.client);
    if (this.pending?.identity === normalized) return this.pending.promise.then((handle) => handle.client);
    const previousDisposal = this.invalidate();
    const generation = this.generation;
    const context: ImClientContext = {
      identity: normalized,
      generation,
      isCurrent: () => this.isCurrent(generation),
      onCurrent: <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args) => {
        if (this.isCurrent(generation)) callback(...args);
      },
      onCancel: (callback) => {
        if (this.isCurrent(generation)) this.pendingCancel = callback;
        else void Promise.resolve().then(callback).catch(() => undefined);
      },
    };
    const promise = (async () => {
      await previousDisposal;
      if (generation !== this.generation) throw new ImLifecycleSupersededError();
      const handle = assertHandle(await this.factory(context));
      if (generation !== this.generation) {
        try { await handle.dispose(); }
        catch (error) {
          throw markImDisposeFailure(error instanceof Error ? error : new Error("IM client disposal failed", { cause: error }));
        }
        throw new ImLifecycleSupersededError();
      }
      this.active = { identity: normalized, generation, handle };
      this.pendingCancel = undefined;
      return handle;
    })();
    this.pending = { identity: normalized, generation, promise };
    void promise.then(() => { if (this.pending?.promise === promise) this.pending = undefined; }, () => { if (this.pending?.promise === promise) this.pending = undefined; });
    return promise.then((handle) => handle.client);
  }

  async close(): Promise<void> { await this.invalidate(); }

  private isCurrent(generation: number): boolean { return generation === this.generation && (this.active?.generation === generation || this.pending?.generation === generation); }

  private invalidate(): Promise<void> {
    if (this.disposeFailure) return Promise.reject(this.disposeFailure);
    this.generation += 1;
    const cancel = this.pendingCancel;
    this.pendingCancel = undefined;
    const pending = this.pending;
    this.pending = undefined;
    const cancellation = cancel ? Promise.resolve().then(cancel).catch((error) => {
      const failure = isImDisposeFailure(error) ? error : markImDisposeFailure(error instanceof Error ? error : new Error("IM client cancellation failed", { cause: error }));
      this.disposeFailure = failure;
      throw failure;
    }) : Promise.resolve();
    const active = this.active;
    this.active = undefined;
    if (!active && !pending && !cancel) return this.disposal;
    const settle = Promise.all([
      cancellation,
      pending ? pending.promise.then(() => undefined, (error) => {
        if (error && (error as { [IM_DISPOSE_FAILED]?: boolean })[IM_DISPOSE_FAILED]) {
          this.disposeFailure = error;
          throw error;
        }
        return undefined;
      }) : Promise.resolve(),
      active ? (async () => {
        try { await active.handle.dispose(); }
        catch (error) {
          const failure = markImDisposeFailure(error instanceof Error ? error : new Error("IM client disposal failed", { cause: error }));
          this.disposeFailure = failure;
          throw failure;
        }
      })() : Promise.resolve(),
    ]).then(() => undefined);
    this.disposal = Promise.all([this.disposal.catch(() => undefined), settle]).then(() => undefined);
    // A pending login rejection is expected when cancellation wins; the lock may
    // be handed off once its dispose has settled. A failed dispose rejects close().
    return this.disposal;
  }
}
