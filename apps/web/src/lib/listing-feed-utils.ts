import type { PublicListing } from "./supply-types.ts";

export function appendUniqueListings(existing: PublicListing[], incoming: PublicListing[]): PublicListing[] {
  const seen = new Set<string>();
  const result: PublicListing[] = [];
  for (const item of [...existing, ...incoming]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
