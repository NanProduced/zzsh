/** Coalesces concurrent identical reads into one in-flight promise; nothing is retained after it settles. */
export function sharedInFlight<T>(read: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const current = read().finally(() => { if (inFlight === current) inFlight = undefined; });
    inFlight = current;
    return current;
  };
}
