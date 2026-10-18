import { normalizeListingQuery } from "./listing-filters.ts";

export { exactAccountLookupQuery } from "./listing-filters.ts";

export function accountSearchHref(value: string): string {
  const query = normalizeListingQuery(value);
  return query ? `/accounts?q=${encodeURIComponent(query)}` : "/accounts";
}
