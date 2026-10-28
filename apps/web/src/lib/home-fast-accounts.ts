import type { PublicListing } from "./supply-types.ts";
import { toListingCard, type ListingCardData } from "./listing-view.ts";

export const HOME_FAST_PAGE_LIMIT = 50;
export const HOME_FAST_DISPLAY_LIMIT = 8;
export const HOME_FAST_MAX_PAGES = 4;

export function isHomeFastAccount(account: Pick<ListingCardData, "historicalReadOnly" | "rentalMode" | "canCreateOrder">): boolean {
  return !account.historicalReadOnly && account.rentalMode === "fast" && account.canCreateOrder === true;
}

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
  const historicalAccounts: ListingCardData[] = [];
  const seenAccounts = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;

  while (pages < maxPages && (accounts.length < displayLimit || historicalAccounts.length < displayLimit)) {
    const page = await readPage(cursor);
    pages += 1;

    for (const listing of page.items) {
      const account = project(listing);
      if (!account || seenAccounts.has(account.id)) continue;
      seenAccounts.add(account.id);
      if (account.historicalReadOnly) {
        if(historicalAccounts.length<displayLimit) historicalAccounts.push(account); else truncated=true;
      } else if(listing.canCreateOrder === true && isHomeFastAccount(account)) {
        if(accounts.length<displayLimit) accounts.push(account); else truncated=true;
      }
    }

    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      if(page.nextCursor) truncated=true;
      cursor = null;
      break;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return {
    accounts,
    historicalAccounts,
    pages,
    hasMore: Boolean(cursor) || truncated,
  };
}
