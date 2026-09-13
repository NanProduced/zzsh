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
  reload: () => void;
};
export function useListingFeed(filters: ListingFilters): ListingFeed {
  const filterKey = listingFilterKey(filters);
  const cursor = filters.cursor;
  const [state, setState] = useState<{ status: FeedStatus; items: PublicListing[]; nextCursor: string | null; errorCode: string | null }>({ status: "loading", items: [], nextCursor: null, errorCode: null });
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const mine = ++seq.current;
    const controller = new AbortController();
    setState({ status: "loading", items: [], nextCursor: null, errorCode: null });
    supplyApi
      .market(listingQuery({ ...filters, cursor }), controller.signal)
      .then((page) => {
        if (mine !== seq.current) return;
        setState({ status: "ready", items: page.items, nextCursor: page.nextCursor, errorCode: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || mine !== seq.current) return;
        setState({ status: "error", items: [], nextCursor: null, errorCode: error instanceof SupplyRequestError ? error.code : "NETWORK_ERROR" });
      });
    return () => controller.abort();
  }, [filterKey, cursor, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, reload };
}
