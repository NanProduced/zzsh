import type { PublicListing } from "./supply-types.ts";
import { toListingCard, type ListingCardData } from "./listing-view.ts";

export const HOME_FAST_PAGE_LIMIT = 50;
export const HOME_FAST_DISPLAY_LIMIT = 8;
export const HOME_FAST_MAX_PAGES = 4;

type PublicPage = {
  items: PublicListing[];
  nextCursor: string | null;
};

type ReadPage = (cursor: string | null) => Promise<PublicPage>;

export async function collectFastAccounts(
  readPage: ReadPage,
  project: (listing: PublicListing) => ListingCardData | null = toListingCard,
  maxPages = HOME_FAST_MAX_PAGES,
  displayLimit = HOME_FAST_DISPLAY_LIMIT,
) {
  const accounts: ListingCardData[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  while (pages < maxPages && accounts.length < displayLimit) {
    const page = await readPage(cursor);
    pages += 1;

    for (const listing of page.items) {
      const account = project(listing);
      if (!account || account.rentalMode !== "fast") continue;
      accounts.push(account);
      if (accounts.length >= displayLimit) break;
    }

    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      cursor = null;
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return {
    accounts,
    pages,
    hasMore: Boolean(cursor),
  };
}
