/**
 * Coalesces concurrent identical reads that belong to the same authorization scope (identity + session +
 * permission generation). A different scope never receives another scope's promise; requesting a new scope
 * forgets every older in-flight entry so a switched/revoked session cannot join it later. Nothing is
 * retained after a read settles (success or failure).
 */
export function scopedInFlight<T>(read: () => Promise<T>): (scope: string) => Promise<T> {
  let current: { scope: string; promise: Promise<T> } | undefined;
  return (scope: string) => {
    if (!scope) return read();
    if (current && current.scope === scope) return current.promise;
    const entry = { scope, promise: undefined as unknown as Promise<T> };
    entry.promise = read().finally(() => { if (current === entry) current = undefined; });
    current = entry;
    return entry.promise;
  };
}
