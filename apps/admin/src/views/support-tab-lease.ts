export type SupportTabLease = {
  supported: boolean;
  /** True when this tab may try the server-side exclusive claim. */
  acquired: Promise<boolean>;
  /** Releases a granted lock. Idempotent; while waiting it cancels the request. */
  release: () => void;
};

/**
 * One tab per administrator/NIM account owns the single NIM login. The lock is
 * held until the caller has disposed the old NIM connection, so the next tab
 * cannot log in before the old client is gone. Without Web Locks the server-side
 * connection claim remains the authority; this is a controlled browser fallback,
 * not a second local guarantee.
 */
export function acquireSupportTabLease(name: string, signal: AbortSignal): SupportTabLease {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) {
    return { supported: false, acquired: Promise.resolve(true), release: () => undefined };
  }
  let granted = false;
  let released = false;
  let aborted = false;
  let done: (() => void) | undefined;
  let settled = false;
  let resolveAcquired: (value: boolean) => void = () => undefined;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });
  const settle = (value: boolean) => {
    if (settled) return;
    settled = true;
    resolveAcquired(value);
  };
  const release = () => {
    if (released) return;
    if (!granted) {
      aborted = true;
      settle(false);
      return;
    }
    released = true;
    done?.();
  };
  signal.addEventListener("abort", () => {
    aborted = true;
    // A granted holder must wait for the caller to dispose the old client and
    // call release(). Only a still-waiting request is cancelled here.
    if (!settled) settle(false);
  }, { once: true });
  void locks.request(name, { mode: "exclusive", signal }, async () => {
    if (aborted || released) return;
    granted = true;
    settle(true);
    await new Promise<void>((resolve) => {
      done = () => { released = true; resolve(); };
      if (released) done();
    });
  }).catch(() => {
    if (!settled) settle(false);
  });
  return { supported: true, acquired, release };
}
