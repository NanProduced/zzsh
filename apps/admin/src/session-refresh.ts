export type SessionRefreshCoordinator<T> = {
  refresh: (redirect?: boolean) => Promise<T>;
  invalidate: (cancelQueued?: boolean) => void;
  beginMutation: () => void;
  endMutation: () => void;
  getEpoch: () => number;
};

type RefreshFlight<T> = { epoch: number; promise: Promise<T>; invalidated: boolean };
type DeferredRefresh<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

/** Keep one /session request in flight and discard responses from an older local auth epoch. */
export function createSessionRefreshCoordinator<T>(
  load: () => Promise<T>,
  apply: (snapshot: T, redirect: boolean) => void,
): SessionRefreshCoordinator<T> {
  let epoch = 0;
  let sequence = 0;
  let appliedSequence = 0;
  let redirectPending = false;
  let flight: RefreshFlight<T> | undefined;
  let invalidationPending = false;
  let queuedRefresh: DeferredRefresh<T> | undefined;
  let mutationDepth = 0;
  let deferredRefresh: DeferredRefresh<T> | undefined;

  const startFlight = (): Promise<T> => {
    const requestedEpoch = epoch;
    const currentSequence = ++sequence;
    const invalidated = invalidationPending;
    invalidationPending = false;
    const promise = load().then((snapshot) => {
      if (requestedEpoch === epoch && currentSequence >= appliedSequence) {
        appliedSequence = currentSequence;
        const shouldRedirect = redirectPending;
        redirectPending = false;
        apply(snapshot, shouldRedirect);
      }
      return snapshot;
    }).finally(() => {
      if (flight?.promise !== promise) return;
      flight = undefined;
      const pending = queuedRefresh;
      if (!pending) return;
      queuedRefresh = undefined;
      try {
        refresh().then(pending.resolve, pending.reject);
      } catch (error) {
        pending.reject(error);
      }
    });
    flight = { epoch: requestedEpoch, promise, invalidated };
    return promise;
  };

  const refresh = (redirect = false): Promise<T> => {
    redirectPending ||= redirect;
    if (mutationDepth > 0) {
      if (!deferredRefresh) {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
        deferredRefresh = { promise, resolve, reject };
      }
      return deferredRefresh.promise;
    }
    const requestedEpoch = epoch;
    const current = flight;
    if (current?.epoch === requestedEpoch) return current.promise;
    if (current?.invalidated) {
      if (!queuedRefresh) {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
        queuedRefresh = { promise, resolve, reject };
      }
      return queuedRefresh.promise;
    }
    return startFlight();
  };

  return {
    refresh,
    invalidate: (cancelQueued = false) => {
      epoch += 1;
      redirectPending = false;
      invalidationPending = true;
      if (cancelQueued && queuedRefresh) {
        queuedRefresh.reject(new Error("Session refresh was cancelled"));
        queuedRefresh = undefined;
      }
    },
    beginMutation: () => {
      mutationDepth += 1;
      epoch += 1;
      redirectPending = false;
      invalidationPending = true;
    },
    endMutation: () => {
      if (mutationDepth === 0) return;
      mutationDepth -= 1;
      if (mutationDepth > 0 || !deferredRefresh) return;
      const pending = deferredRefresh;
      deferredRefresh = undefined;
      refresh().then(pending.resolve, pending.reject);
    },
    getEpoch: () => epoch,
  };
}
