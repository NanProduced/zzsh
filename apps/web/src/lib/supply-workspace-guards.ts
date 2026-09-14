export type FrozenRequest<T> = { body: T; key: string };

export type QueryRequest = { id: number; key: string };

type IdentityWaiter = { canResume: () => boolean; resolve: (value: boolean) => void };

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function freezeRequest<T>(body: T, key: string): FrozenRequest<T> {
  return { body: deepFreeze(structuredClone(body)), key };
}

export function isCurrentQuery(request: QueryRequest, currentId: number, currentKey: string): boolean {
  return request.id === currentId && request.key === currentKey;
}

export function mergePageById<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

export class IdentityPauseGate {
  private paused = true;
  private waiters: IdentityWaiter[] = [];

  startCheck(): void {
    this.paused = true;
  }

  markFailed(): void {
    this.paused = true;
  }

  markConfirmed(): void {
    this.paused = false;
    this.resolveWaiters();
  }

  cancelWaiters(): void {
    this.resolveWaiters(false);
  }

  cancel(): void {
    this.paused = true;
    this.cancelWaiters();
  }

  wait(canResume: () => boolean): Promise<boolean> {
    if (!canResume()) return Promise.resolve(false);
    if (!this.paused) return Promise.resolve(true);
    return new Promise((resolve) => this.waiters.push({ canResume, resolve }));
  }

  private resolveWaiters(force?: boolean): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(force ?? waiter.canResume());
  }
}
