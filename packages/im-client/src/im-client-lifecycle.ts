export type ImClientHandle<T> = { client: T; dispose: () => void | Promise<void> };

export type ImClientContext = {
  identity: string;
  generation: number;
  isCurrent: () => boolean;
  onCurrent: <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args) => void;
};

export type ImClientFactory<T> = (context: ImClientContext) => ImClientHandle<T> | Promise<ImClientHandle<T>>;
export type ImClientLifecycleSnapshot = { state: "idle" | "opening" | "ready"; identity: string | null; generation: number };

export class ImLifecycleSupersededError extends Error {
  constructor() { super("IM client lifecycle operation was superseded"); this.name = "ImLifecycleSupersededError"; }
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
  private disposal = Promise.resolve();

  constructor(factory: ImClientFactory<T>) { this.factory = factory; }

  getSnapshot(): ImClientLifecycleSnapshot {
    if (this.active) return { state: "ready", identity: this.active.identity, generation: this.active.generation };
    if (this.pending) return { state: "opening", identity: this.pending.identity, generation: this.pending.generation };
    return { state: "idle", identity: null, generation: this.generation };
  }

  open(identity: string): Promise<T> {
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
    };
    const promise = (async () => {
      await previousDisposal;
      if (generation !== this.generation) throw new ImLifecycleSupersededError();
      const handle = assertHandle(await this.factory(context));
      if (generation !== this.generation) { await handle.dispose(); throw new ImLifecycleSupersededError(); }
      this.active = { identity: normalized, generation, handle };
      return handle;
    })();
    this.pending = { identity: normalized, generation, promise };
    void promise.then(() => { if (this.pending?.promise === promise) this.pending = undefined; }, () => { if (this.pending?.promise === promise) this.pending = undefined; });
    return promise.then((handle) => handle.client);
  }

  async close(): Promise<void> { await this.invalidate(); }

  private isCurrent(generation: number): boolean { return generation === this.generation && (this.active?.generation === generation || this.pending?.generation === generation); }

  private invalidate(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    const active = this.active;
    this.active = undefined;
    if (!active) return this.disposal;
    const dispose = async () => { await active.handle.dispose(); };
    this.disposal = this.disposal.then(dispose, dispose);
    return this.disposal;
  }
}
