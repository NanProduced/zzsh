"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { listingFilterKey, listingQuery, type ListingFilters } from "@/lib/listing-filters";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import type { PublicListing } from "@/lib/supply-types";

export type FeedStatus = "loading" | "ready" | "error";
export type ListingFeed = {
  status: FeedStatus;
  items: PublicListing[];
  nextCursor: string | null;
  errorCode: string | null;
  cursorInvalid: boolean;
  reload: () => void;
};
type ListingFeedState = Omit<ListingFeed, "reload">;
export function useListingFeed(filters: ListingFilters): ListingFeed {
  const filterKey = listingFilterKey(filters);
  const cursor = filters.cursor;
  const [state, setState] = useState<ListingFeedState>({ status: "loading", items: [], nextCursor: null, errorCode: null, cursorInvalid: false });
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const mine = ++seq.current;
    const controller = new AbortController();
    setState({ status: "loading", items: [], nextCursor: null, errorCode: null, cursorInvalid: false });
    supplyApi
      .market(listingQuery({ ...filters, cursor }), controller.signal)
      .then((page) => {
        if (mine !== seq.current) return;
        setState({ status: "ready", items: page.items, nextCursor: page.nextCursor, errorCode: null, cursorInvalid: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || mine !== seq.current) return;
        const cursorInvalid = Boolean(
          cursor &&
          error instanceof SupplyRequestError &&
          (error.status === 400 || error.status === 409) &&
          /cursor/i.test(error.message),
        );
        setState({ status: "error", items: [], nextCursor: null, errorCode: error instanceof SupplyRequestError ? error.code : "NETWORK_ERROR", cursorInvalid });
      });
    return () => controller.abort();
  }, [filterKey, cursor, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, reload };
}
