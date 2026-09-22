"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { listingFilterKey, listingQuery, type ListingFilters } from "@/lib/listing-filters";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import { appendUniqueListings } from "@/lib/listing-feed-utils";
import type { PublicListing, PublicListingFilterMetadata, SupplyFieldError } from "@/lib/supply-types";

export type FeedStatus = "loading" | "ready" | "error";
export type ListingFeed = {
  status: FeedStatus;
  items: PublicListing[];
  nextCursor: string | null;
  requestedCursors: Array<string | null>;
  error: { status: number; code: string; details: SupplyFieldError[] } | null;
  cursorInvalid: boolean;
  isLoadingMore: boolean;
  loadMoreError: { status: number; code: string; details: SupplyFieldError[] } | null;
  loadMoreCursorInvalid: boolean;
  resumeIncomplete: boolean;
  scanBudgetReached: boolean;
  loadMore: () => void;
  reload: () => void;
  reloadFirstPage: () => void;
};
type FeedState = Omit<ListingFeed, "loadMore" | "reload" | "reloadFirstPage">;
const EMPTY: FeedState = {
  status: "loading", items: [], nextCursor: null, requestedCursors: [], error: null,
  cursorInvalid: false, isLoadingMore: false, loadMoreError: null, loadMoreCursorInvalid: false,
  resumeIncomplete: false, scanBudgetReached: false,
};

function errorInfo(error: unknown) {
  return error instanceof SupplyRequestError
    ? { status: error.status, code: error.code, details: error.details }
    : { status: 0, code: "NETWORK_ERROR", details: [] };
}

function invalidCursor(error: unknown, cursor: string | null): boolean {
  return Boolean(cursor && error instanceof SupplyRequestError && [400, 409].includes(error.status) &&
    (/cursor/i.test(error.message) || error.details.some((detail) => /cursor/i.test(detail.path))));
}

export function useListingFeed(
  filters: ListingFilters,
  metadata: PublicListingFilterMetadata | null,
  options: { enabled?: boolean; replayCursors?: Array<string | null> } = {},
): ListingFeed {
  const enabled = options.enabled ?? true;
  const replayKey = options.replayCursors ? JSON.stringify(options.replayCursors) : "";
  const filterKey = listingFilterKey(filters, metadata);
  const [state, setState] = useState<FeedState>(EMPTY);
  const stateRef = useRef(state);
  const sequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const completedReplay = useRef<{ filterKey: string; attempt: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startFromFirstPage, setStartFromFirstPage] = useState(false);

  const commit = useCallback((next: FeedState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => () => {
    sequence.current += 1;
    busy.current = false;
    activeController.current?.abort();
    activeController.current = null;
  }, [attempt, enabled, filterKey]);

  useEffect(() => {
    if (!enabled) {
      completedReplay.current = null;
      commit({ ...EMPTY });
      return;
    }
    const completed = completedReplay.current;
    // The parent consumes a successful return snapshot after restoring scroll; do not turn that into a first-page reload.
    if (!replayKey && completed?.filterKey === filterKey && completed.attempt === attempt) {
      completedReplay.current = null;
      return;
    }
    completedReplay.current = null;
    const mine = ++sequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    busy.current = true;
    commit({ ...EMPTY, status: "loading" });
    const desired = options.replayCursors?.length ? options.replayCursors : [startFromFirstPage ? null : filters.cursor];

    void (async () => {
      let items: PublicListing[] = [];
      let nextCursor: string | null = null;
      let scanBudgetReached = false;
      const requestedCursors: Array<string | null> = [];
      let incomplete = false;
      try {
        for (let index = 0; index < desired.length; index += 1) {
          const cursor = desired[index] ?? null;
          if (requestedCursors.includes(cursor)) {
            incomplete = true;
            break;
          }
          if (index > 0 && nextCursor !== cursor) {
            incomplete = true;
            break;
          }
          const page = await supplyApi.market(listingQuery({ ...filters, cursor }, metadata), controller.signal);
          if (controller.signal.aborted || mine !== sequence.current) return;
          requestedCursors.push(cursor);
          items = appendUniqueListings(items, page.items);
          nextCursor = page.nextCursor && !requestedCursors.includes(page.nextCursor) ? page.nextCursor : null;
          scanBudgetReached = page.scanBudgetReached;
        }
        if (mine !== sequence.current) return;
        if (replayKey) completedReplay.current = { filterKey, attempt };
        commit({ ...EMPTY, status: "ready", items, nextCursor, requestedCursors, scanBudgetReached, resumeIncomplete: incomplete });
      } catch (error) {
        if (controller.signal.aborted || mine !== sequence.current) return;
        commit({
          ...EMPTY,
          status: "error",
          items,
          nextCursor,
          requestedCursors,
          error: errorInfo(error),
          cursorInvalid: invalidCursor(error, requestedCursors.at(-1) ?? desired[requestedCursors.length] ?? null),
          resumeIncomplete: incomplete,
          scanBudgetReached,
        });
      } finally {
        if (mine === sequence.current) {
          busy.current = false;
          if (activeController.current === controller) activeController.current = null;
        }
      }
    })();

    // Cursor-only URL updates describe the current loaded batch and must not restart the accumulated feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, commit, enabled, filterKey, replayKey]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    const cursor = current.nextCursor;
    if (!enabled || current.status !== "ready" || !cursor || current.requestedCursors.includes(cursor) || busy.current) return;
    const mine = sequence.current;
    const controller = new AbortController();
    activeController.current = controller;
    busy.current = true;
    commit({ ...current, isLoadingMore: true, loadMoreError: null });
    void supplyApi.market(listingQuery({ ...filters, cursor }, metadata), controller.signal)
      .then((page) => {
        if (controller.signal.aborted || mine !== sequence.current) return;
        commit({
          ...stateRef.current,
          items: appendUniqueListings(stateRef.current.items, page.items),
          nextCursor: page.nextCursor && ![...stateRef.current.requestedCursors, cursor].includes(page.nextCursor) ? page.nextCursor : null,
          requestedCursors: [...stateRef.current.requestedCursors, cursor],
          scanBudgetReached: page.scanBudgetReached,
          isLoadingMore: false,
          loadMoreError: null,
          loadMoreCursorInvalid: false,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || mine !== sequence.current) return;
        commit({ ...stateRef.current, isLoadingMore: false, loadMoreError: errorInfo(error), loadMoreCursorInvalid: invalidCursor(error, cursor) });
      })
      .finally(() => {
        if (mine === sequence.current) {
          busy.current = false;
          if (activeController.current === controller) activeController.current = null;
        }
      });
  }, [commit, enabled, filters, metadata]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const reloadFirstPage = useCallback(() => {
    setStartFromFirstPage(true);
    setAttempt((value) => value + 1);
  }, []);
  return { ...state, loadMore, reload, reloadFirstPage };
}
