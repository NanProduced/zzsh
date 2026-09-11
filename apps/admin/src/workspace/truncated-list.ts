export function listWasTruncated(fetchedCount: number, requestedLimit: number): boolean {
  return fetchedCount >= requestedLimit;
}

export function canClaimCompleteTimeRange(fetchedCount: number, requestedLimit: number): boolean {
  return !listWasTruncated(fetchedCount, requestedLimit);
}

export function previewItems<T>(items: readonly T[], displayLimit: number): T[] {
  return items.slice(0, displayLimit);
}
