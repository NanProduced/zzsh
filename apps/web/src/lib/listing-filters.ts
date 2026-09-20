// URL <-> public listing query mapping. Server-supported filters only.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
export const LISTING_PAGE_SIZE = 12;
export const LISTING_MAX_SKINS = 50;

export type ListingFilters = {
  game: string | null;
  item: string | null;
  minQty: string | null;
  skinIds: string[];
  match: "ANY" | "ALL";
  q: string | null;
  cursor: string | null;
  limit: number;
};

function text(value: string | string[] | undefined): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" ? single : null;
}
function list(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).filter((v) => ID_PATTERN.test(v));
}
export function normalizeListingQuery(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

export function parseListingFilters(input: Record<string, string | string[] | undefined>): ListingFilters {
  const game = text(input.game);
  const item = text(input.item);
  const minQty = text(input.minQty);
  const match = text(input.match) === "ALL" ? "ALL" : "ANY";
  const cursor = text(input.cursor);
  const limit = Number(text(input.limit) ?? LISTING_PAGE_SIZE);
  const skinIds = [...new Set(list(input.skinId))].slice(0, LISTING_MAX_SKINS);
  return {
    game: game && ID_PATTERN.test(game) ? game : null,
    item: item && ID_PATTERN.test(item) ? item : null,
    minQty: minQty && /^\d{1,24}$/.test(minQty) ? minQty : null,
    skinIds,
    match,
    q: normalizeListingQuery(text(input.q)),
    cursor: cursor && CURSOR_PATTERN.test(cursor) ? cursor : null,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : LISTING_PAGE_SIZE,
  };
}

export function listingQuery(filters: ListingFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.game) query.set("gameId", filters.game);
  if (filters.item) {
    query.set("itemId", filters.item);
    if (filters.minQty) query.set("minQuantity", filters.minQty);
  }
  for (const skinId of filters.skinIds) query.append("skinId", skinId);
  if (filters.skinIds.length) query.set("skinMatch", filters.match);
  if (filters.q) query.set("q", filters.q);
  query.set("limit", String(filters.limit));
  if (filters.cursor) query.set("cursor", filters.cursor);
  return query;
}

export function listingFiltersUrl(filters: ListingFilters): string {
  const query = new URLSearchParams();
  if (filters.game) query.set("game", filters.game);
  if (filters.item) {
    query.set("item", filters.item);
    if (filters.minQty) query.set("minQty", filters.minQty);
  }
  for (const skinId of filters.skinIds) query.append("skinId", skinId);
  if (filters.skinIds.length > 1 || (filters.skinIds.length === 1 && filters.match === "ALL")) query.set("match", filters.match);
  if (filters.q) query.set("q", filters.q);
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.limit !== LISTING_PAGE_SIZE) query.set("limit", String(filters.limit));
  return "/accounts" + (query.size ? "?" + query.toString() : "");
}

// Filter changes reset the cursor; pagination keeps it.
export function withFilterChange(filters: ListingFilters, patch: Partial<Omit<ListingFilters, "cursor">>): ListingFilters {
  return { ...filters, ...patch, cursor: null };
}
// Effect key without the cursor: cursor moves only refetch the page, not the filter set.
export function listingFilterKey(filters: ListingFilters): string {
  return listingQuery({ ...filters, cursor: null }).toString();
}
export function toggleSkinId(filters: ListingFilters, skinId: string): ListingFilters {
  const skinIds = filters.skinIds.includes(skinId)
    ? filters.skinIds.filter((id) => id !== skinId)
    : [...filters.skinIds, skinId].slice(0, LISTING_MAX_SKINS);
  return withFilterChange(filters, { skinIds });
}
export function activeListingFilterCount(filters: ListingFilters): number {
  return (filters.item ? 1 : 0) + (filters.minQty && filters.item ? 1 : 0) + filters.skinIds.length + (filters.q ? 1 : 0);
}
