"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Drawer } from "@heroui/react";
import { RotateCw, SlidersHorizontal, X } from "lucide-react";
import { AccountCard } from "@/components/delta/account-card";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";
import { AccountCardEmpty } from "@/components/delta/account-card-empty";
import { FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { ServiceShell } from "@/components/layout/service-shell";
import { MarketFilterControls } from "@/components/market/market-filter-controls";
import {
  activeListingFilterCount,
  LISTING_PAGE_SIZE,
  listingFilterKey,
  listingFiltersUrl,
  listingRequestBudget,
  listingRequestBudgetMessage,
  listingUrlRejectedValues,
  parseListingFilters,
  reconcileListingFilters,
  resolveSkinOwner,
  skinGroupOptions,
  withFilterChange,
  normalizeListingQuery,
  exactAccountLookupQuery,
  type ListingFilters,
} from "@/lib/listing-filters";
import { consumeAccountReturnSnapshot, type AccountReturnSnapshot } from "@/lib/account-return";
import { toListingCard } from "@/lib/listing-view";
import { SupplyRequestError, supplyApi } from "@/lib/supply-client";
import type { PublicCatalog, PublicListingFilterMetadata, SupplyGame } from "@/lib/supply-types";
import { useListingFeed } from "./use-listing-feed";
import { DeltaBanner } from "./market-banner";
import { type Directory, resultError } from "./market-error-display";
import {
  MarketResultsToolbar,
  MarketSortBar,
  MarketActiveChips,
  useMarketSort,
  useActiveListingTags,
} from "./market-toolbar";
import "./market.css";

function searchParamsRecord(search: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const previous = result[key];
    result[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return result;
}

export function AccountMarket({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const initialFilters = parseListingFilters(searchParams);
  return <FavoritesProvider><MarketView initialFilters={initialFilters} /></FavoritesProvider>;
}

/** Mobile gets one compact list; the URL keeps view so a shared desktop link still restores. */
function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 799px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

function MarketView({ initialFilters }: { initialFilters: ListingFilters }) {
  const [filters, setFilters] = useState(initialFilters);
  const [filterSourceReady, setFilterSourceReady] = useState(false);
  const [games, setGames] = useState<Directory<SupplyGame[]>>({ status: "loading", data: null });
  const [metadata, setMetadata] = useState<Directory<PublicListingFilterMetadata>>({ status: filters.game ? "loading" : "idle", data: null });
  const [catalog, setCatalog] = useState<Directory<PublicCatalog>>({ status: "idle", data: null });
  const [skinSearchCatalog, setSkinSearchCatalog] = useState<Directory<PublicCatalog>>({ status: "idle", data: null });
  const [skinSearch, setSkinSearch] = useState("");
  const [skinOwner, setSkinOwner] = useState("");
  const [skinRarity, setSkinRarity] = useState("");
  const [activeSkinCategoryId, setActiveSkinCategoryId] = useState("");
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [skinSearchAttempt, setSkinSearchAttempt] = useState(0);
  const [loadingMoreSkinSearch, setLoadingMoreSkinSearch] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<ListingFilters | null>(null);
  const draftRef = useRef<ListingFilters | null>(null);
  const [draftResetToken, setDraftResetToken] = useState(0);
  const draftFlushers = useRef(new Set<() => boolean>());
  const registerDraftFlusher = useCallback((fn: () => boolean) => {
    draftFlushers.current.add(fn);
    return () => { draftFlushers.current.delete(fn); };
  }, []);
  const onDraftChange = useCallback((next: ListingFilters) => {
    draftRef.current = next;
    setDraftFilters(next);
  }, []);
  const compact = useCompactViewport();
  useEffect(() => {
    if (!compact && mobileFiltersOpen) {
      draftRef.current = null;
      setDraftFilters(null);
      setMobileFiltersOpen(false);
    }
  }, [compact, mobileFiltersOpen]);
  const openMobileFilters = () => {
    draftRef.current = filters;
    setDraftFilters(filters);
    setMobileFiltersOpen(true);
  };
  const discardMobileDraft = () => {
    draftRef.current = null;
    setDraftFilters(null);
    setMobileFiltersOpen(false);
  };
  const applyMobileDraft = () => {
    let valid = true;
    draftFlushers.current.forEach((flush) => { if (!flush()) valid = false; });
    if (!valid) {
      document.querySelector<HTMLElement>(".market-filter-drawer-dialog [aria-invalid=true]")?.focus();
      return;
    }
    const next = draftRef.current ?? filters;
    draftRef.current = null;
    setDraftFilters(null);
    setMobileFiltersOpen(false);
    navigate(next);
  };
  const clearMobileDraft = () => {
    const base = draftRef.current ?? filters;
    const cleared = { ...base, filters: {}, q: null, cursor: null };
    draftRef.current = cleared;
    setDraftFilters(cleared);
    setDraftResetToken((value) => value + 1);
  };
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const filtersOpenTouched = useRef(false);
  const [restoreReady, setRestoreReady] = useState(false);
  const [returnSnapshot, setReturnSnapshot] = useState<AccountReturnSnapshot | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const metadataRefreshed = useRef<string | null>(null);
  const invalidCursorHandled = useRef<string | null>(null);
  const catalogSequence = useRef(0);
  const catalogController = useRef<AbortController | null>(null);
  const skinSearchSequence = useRef(0);
  const skinSearchController = useRef<AbortController | null>(null);
  const skinSearchBusy = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const initialRestoreDone = useRef(false);
  const rejectedSharePathRef = useRef<string | null>(null);
  const activeMetadata = metadata.status === "ready" ? metadata.data : null;
  const filterKey = listingFilterKey(filters, activeMetadata);
  const skinField = activeMetadata?.fields.find((entry) => entry.key === "skinGroups");
  const skinCategories = skinGroupOptions(skinField, catalog.data);
  const skinTypeMode = Boolean(skinField?.ownerKinds);
  const resolvedSkinCategoryId = skinCategories.some((category) => category.id === activeSkinCategoryId)
    ? activeSkinCategoryId
    : skinCategories[0]?.id ?? "";
  const normalizedSkinSearch = skinSearch.normalize("NFKC").trim().slice(0, 80);
  // Owner options follow the active category's kind; a category re-resolved on catalog re-read (melee has no
  // owner after 2108) must not keep sending an ownerId that the current type cannot use.
  const resolvedSkinCategory = skinCategories.find((category) => category.id === resolvedSkinCategoryId);
  const resolvedSkinOwner = catalog.data?.game.id === filters.game ? resolveSkinOwner(catalog.data.owners, skinOwner, resolvedSkinCategory?.ownerKind) : "";
  const resolvedSkinRarity = catalog.data?.game.id === filters.game && catalog.data.rarities.some((rarity) => rarity.code === skinRarity) ? skinRarity : "";
  const lookupNumber = exactAccountLookupQuery(filters.q);
  const feed = useListingFeed(filters, metadata.data, {
    enabled: filterSourceReady && (lookupNumber !== null || (restoreReady && metadata.status === "ready" && Boolean(metadata.data?.available))),
    replayCursors: returnSnapshot?.filterKey === filterKey ? returnSnapshot.pageCursors : undefined,
  });

  const navigate = useCallback((next: ListingFilters, options: { push?: boolean } = {}) => {
    const address = listingFiltersUrl(next);
    const budget = listingRequestBudget(next, activeMetadata, null);
    if (budget?.kind === "page") {
      rejectedSharePathRef.current = address;
      setRecoveryNotice(listingRequestBudgetMessage(budget));
      setFilters(next);
      return;
    }
    rejectedSharePathRef.current = null;
    if (listingFilterKey(filters, activeMetadata) !== listingFilterKey(next, activeMetadata)) setReturnSnapshot(null);
    setRecoveryNotice(budget ? listingRequestBudgetMessage(budget) : null);
    setFilters(next);
    if (restoreReady && typeof window !== "undefined" && window.location.pathname === "/accounts" && window.location.pathname + window.location.search !== address) {
      if (options.push) window.history.pushState(window.history.state, "", address);
      else window.history.replaceState(window.history.state, "", address);
    }
  }, [activeMetadata, filters, restoreReady]);

  useEffect(() => {
    const next = { ...initialFilters, cursor: null, limit: LISTING_PAGE_SIZE };
    setFilters(next);
    setFilterSourceReady(true);
    // URL conditions are authoritative; reconciliation waits for public metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const restoreFromAddress = () => {
      const next = { ...parseListingFilters(searchParamsRecord(window.location.search)), cursor: null, limit: LISTING_PAGE_SIZE };
      initialRestoreDone.current = false;
      setRestoreReady(false);
      setReturnSnapshot(null);
      setRecoveryNotice(null);
      rejectedSharePathRef.current = null;
      setFilters(next);
      setFilterSourceReady(true);
    };
    window.addEventListener("popstate", restoreFromAddress);
    return () => window.removeEventListener("popstate", restoreFromAddress);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    supplyApi.games(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setGames({ status: "ready", data: data.games });
    }).catch(() => {
      if (!controller.signal.aborted) setGames({ status: "error", data: null });
    });
    return () => controller.abort();
    // Resolve a missing game context once; users do not choose among games on this route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!lookupNumber && games.status === "ready" && !filters.game && games.data?.length === 1) navigate({ ...filters, game: games.data[0]!.id });
  }, [filters, games, navigate]);

  useEffect(() => {
    if (!filters.game) {
      setMetadata({ status: "idle", data: null });
      return;
    }
    const controller = new AbortController();
    setMetadata({ status: "loading", data: null });
    supplyApi.listingFilters(filters.game, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      if (data.gameId !== filters.game || data.queryVersion !== 2) throw new Error("筛选 metadata 与当前游戏版本不匹配");
      setMetadata({ status: "ready", data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setMetadata({ status: "error", data: null, error: error instanceof SupplyRequestError ? error : null });
    });
    return () => controller.abort();
  }, [filters.game, metadataAttempt]);

  useEffect(() => {
    if (!filters.game) {
      setCatalog({ status: "idle", data: null });
      return;
    }
    catalogController.current?.abort();
    const controller = new AbortController();
    catalogController.current = controller;
    const requestId = ++catalogSequence.current;
    setCatalog({ status: "loading", data: null });
    supplyApi.browseCatalog(filters.game, new URLSearchParams({ limit: "30" }), controller.signal).then((data) => {
      if (!controller.signal.aborted && requestId === catalogSequence.current) setCatalog({ status: "ready", data });
    }).catch(() => {
      if (!controller.signal.aborted && requestId === catalogSequence.current) setCatalog({ status: "error", data: null });
    });
    return () => {
      controller.abort();
      if (catalogController.current === controller) catalogController.current = null;
    };
  }, [filters.game, catalogAttempt]);

  useEffect(() => {
    skinSearchController.current?.abort();
    skinSearchController.current = null;
    skinSearchBusy.current = false;
    setLoadingMoreSkinSearch(false);
    const query = normalizedSkinSearch;
    const categoryId = resolvedSkinCategoryId;
    if (!filters.game || !categoryId) {
      skinSearchSequence.current += 1;
      setSkinSearchCatalog({ status: "idle", data: null });
      return;
    }

    const controller = new AbortController();
    const requestId = ++skinSearchSequence.current;
    skinSearchController.current = controller;
    setSkinSearchCatalog({ status: "loading", data: null });
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "30", [skinTypeMode ? "ownerKind" : "categoryId"]: categoryId });
      if (query) params.set("q", query);
      if (resolvedSkinOwner) params.set("ownerId", resolvedSkinOwner);
      if (resolvedSkinRarity) params.set("rarityCode", resolvedSkinRarity);
      supplyApi.browseCatalog(filters.game!, params, controller.signal).then((data) => {
        if (controller.signal.aborted || requestId !== skinSearchSequence.current) return;
        setSkinSearchCatalog({ status: "ready", data });
        if (skinSearchController.current === controller) skinSearchController.current = null;
      }).catch((error: unknown) => {
        if (controller.signal.aborted || requestId !== skinSearchSequence.current) return;
        setSkinSearchCatalog({ status: "error", data: null, error: error instanceof SupplyRequestError ? error : null });
        if (skinSearchController.current === controller) skinSearchController.current = null;
      });
    }, query ? 250 : 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (skinSearchController.current === controller) skinSearchController.current = null;
      if (requestId === skinSearchSequence.current) skinSearchSequence.current += 1;
    };
  }, [filters.game, normalizedSkinSearch, resolvedSkinCategoryId, resolvedSkinOwner, resolvedSkinRarity, skinSearchAttempt, skinTypeMode]);

  useEffect(() => {
    const page = skinSearchCatalog.data;
    if (!page || page.game.id !== filters.game) return;
    setCatalog((previous) => {
      if (!previous.data || previous.data.game.id !== page.game.id || previous.data.game.catalogRevision !== page.game.catalogRevision) return previous;
      const ids = new Set(previous.data.skins.map((skin) => skin.id));
      const added = page.skins.filter((skin) => !ids.has(skin.id));
      return added.length ? { ...previous, data: { ...previous.data, skins: [...previous.data.skins, ...added] } } : previous;
    });
  }, [filters.game, skinSearchCatalog.data]);

  useEffect(() => {
    if (!filterSourceReady || metadata.status !== "ready" || filters.game !== metadata.data?.gameId) return;
    if (!metadata.data.available) {
      if (!initialRestoreDone.current) {
        initialRestoreDone.current = true;
        const address = listingFiltersUrl(filters);
        const budget = listingRequestBudget(filters, metadata.data, null);
        if (budget) setRecoveryNotice(listingRequestBudgetMessage(budget));
        else if (window.location.pathname + window.location.search !== address) setRecoveryNotice("链接参数已按当前页面规范整理，筛选条件已保留。");
        if (window.location.pathname === "/accounts" && window.location.pathname + window.location.search !== address) window.history.replaceState(window.history.state, "", address);
        setRestoreReady(true);
      }
      return;
    }
    if (catalog.status !== "ready" && catalog.status !== "error") return;
    const rawBudget = listingRequestBudget(filters, metadata.data, null);
    if (rawBudget) {
      setRecoveryNotice(listingRequestBudgetMessage(rawBudget));
      if (!initialRestoreDone.current) {
        initialRestoreDone.current = true;
        setRestoreReady(true);
      }
      return;
    }
    const skinIds = catalog.status === "ready" && !catalog.data?.nextCursor
      ? new Set(catalog.data?.skins.map((skin) => skin.id) ?? [])
      : undefined;
    const reconciled = reconcileListingFilters(filters, metadata.data, skinIds);
    const changed = listingFiltersUrl(reconciled) !== listingFiltersUrl(filters);
    if (changed) {
      rejectedSharePathRef.current = null;
      if (metadata.data.skinGrouping === "TYPE" && filters.filters.skinGroups?.some((group) => group.categoryId)) {
        setRecoveryNotice("旧链接中的皮肤分类已停用，请重新选择皮肤；其他有效条件已保留。");
      }
      setFilters(reconciled);
    }
    if (!initialRestoreDone.current) {
      initialRestoreDone.current = true;
      const address = listingFiltersUrl(reconciled);
      const budget = listingRequestBudget(reconciled, metadata.data, null);
      // 只有真的丢掉/改写了用户显式指定的可识别参数时才提示；补默认游戏、补默认排序、
      // 省掉与默认值相同的 sort/direction 都属静默规范化，不能误报“参数不可用”。
      const rejected = listingUrlRejectedValues(searchParamsRecord(window.location.search), filters);
      if (budget) setRecoveryNotice(listingRequestBudgetMessage(budget));
      else if (rejected.length > 0) setRecoveryNotice("链接中的部分参数不可用，已保留仍合法的筛选条件。");
      if (window.location.pathname === "/accounts" && window.location.pathname + window.location.search !== address) window.history.replaceState(window.history.state, "", address);
      const snapshot = consumeAccountReturnSnapshot(address, listingFilterKey(reconciled, metadata.data));
      if (snapshot) setReturnSnapshot(snapshot);
      setRestoreReady(true);
    }
  }, [catalog, filterSourceReady, filters, metadata]);

  useEffect(() => {
    if (!restoreReady || window.location.pathname !== "/accounts") return;
    const address = listingFiltersUrl(filters);
    if (rejectedSharePathRef.current === address) return;
    if (window.location.pathname + window.location.search !== address) window.history.replaceState(window.history.state, "", address);
  }, [filters, restoreReady]);

  const conflictStatus = lookupNumber ? null : feed.error?.status === 409 ? 409 : feed.loadMoreError?.status === 409 ? 409 : null;
  useEffect(() => {
    if (conflictStatus !== 409 || metadataRefreshed.current === filterKey) return;
    metadataRefreshed.current = filterKey;
    setRecoveryNotice("筛选规则已更新，正在刷新可用条件；保留符合新规则的选择。");
    setReturnSnapshot(null);
    setMetadata({ status: "loading", data: null });
    setCatalog({ status: "loading", data: null });
    navigate(withFilterChange(filters, {}));
    setMetadataAttempt((value) => value + 1);
    setCatalogAttempt((value) => value + 1);
    feed.reloadFirstPage();
  }, [conflictStatus, feed.reloadFirstPage, filterKey, filters, navigate]);

  const invalidCursor = feed.cursorInvalid || feed.loadMoreCursorInvalid;
  useEffect(() => {
    if (!invalidCursor || conflictStatus === 409 || invalidCursorHandled.current === filterKey) return;
    invalidCursorHandled.current = filterKey;
    setRecoveryNotice("浏览位置已过期，已从当前筛选的最新结果重新读取。");
    setReturnSnapshot((snapshot) => snapshot ? { ...snapshot, pageCursors: [null] } : null);
    navigate(withFilterChange(filters, {}));
    feed.reloadFirstPage();
  }, [conflictStatus, feed.cursorInvalid, feed.loadMoreCursorInvalid, feed.reloadFirstPage, filterKey, filters, invalidCursor, navigate]);

  useEffect(() => {
    const snapshot = returnSnapshot;
    if (!snapshot || snapshot.filterKey !== filterKey || feed.status !== "ready" ||
      (feed.requestedCursors.length < snapshot.pageCursors.length && !feed.resumeIncomplete)) return;
    const frame = requestAnimationFrame(() => {
      const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(snapshot.scrollY, maximum), behavior: "instant" as ScrollBehavior });
      setReturnSnapshot(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [feed.requestedCursors.length, feed.resumeIncomplete, feed.status, filterKey, returnSnapshot]);

  useEffect(() => {
    const node = endRef.current;
    if (!node || feed.status !== "ready" || !feed.nextCursor || feed.scanBudgetReached || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) feed.loadMore();
    }, { rootMargin: "700px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [feed.loadMore, feed.nextCursor, feed.scanBudgetReached, feed.status]);

  const loadMoreSkinSearch = useCallback(async () => {
    const current = skinSearchCatalog.data;
    const query = normalizedSkinSearch;
    const categoryId = resolvedSkinCategoryId;
    const cursor = current?.nextCursor;
    if (!filters.game || !categoryId || !cursor || skinSearchBusy.current) return;
    const requestId = skinSearchSequence.current;
    const controller = new AbortController();
    skinSearchController.current?.abort();
    skinSearchController.current = controller;
    skinSearchBusy.current = true;
    setLoadingMoreSkinSearch(true);
    try {
      const params = new URLSearchParams({ limit: "30", [skinTypeMode ? "ownerKind" : "categoryId"]: categoryId, cursor });
      if (query) params.set("q", query);
      if (resolvedSkinOwner) params.set("ownerId", resolvedSkinOwner);
      if (resolvedSkinRarity) params.set("rarityCode", resolvedSkinRarity);
      const page = await supplyApi.browseCatalog(filters.game, params, controller.signal);
      if (controller.signal.aborted || requestId !== skinSearchSequence.current) return;
      setSkinSearchCatalog((previous) => {
        if (!previous.data || previous.data.game.id !== filters.game) return previous;
        const ids = new Set(previous.data.skins.map((skin) => skin.id));
        return {
          ...previous,
          status: "ready",
          data: {
            ...previous.data,
            skins: [...previous.data.skins, ...page.skins.filter((skin) => !ids.has(skin.id))],
            nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
          },
        };
      });
    } catch {
      if (!controller.signal.aborted && requestId === skinSearchSequence.current) {
        setRecoveryNotice("更多匹配皮肤加载失败；已选条件与已加载结果保留，可再次加载。");
      }
    } finally {
      if (requestId === skinSearchSequence.current) {
        skinSearchBusy.current = false;
        setLoadingMoreSkinSearch(false);
        if (skinSearchController.current === controller) skinSearchController.current = null;
      }
    }
  }, [filters.game, normalizedSkinSearch, resolvedSkinCategoryId, resolvedSkinOwner, resolvedSkinRarity, skinSearchCatalog.data, skinTypeMode]);

  const game = catalog.data?.game ?? games.data?.find((entry) => entry.id === filters.game) ?? null;
  const filterCount = activeListingFilterCount(filters);
  const matchedResourceItemIds = useMemo(
    () => new Set((filters.filters.resources ?? []).map((resource) => resource.itemId)),
    [filters.filters.resources]
  );
  useEffect(() => {
    if (!filtersOpenTouched.current && filterCount > 0) setFiltersOpen(true);
  }, [filterCount]);
  // Growing back to desktop closes the sheet and drops the uncommitted draft; the feed, cursor and URL stay.
  useEffect(() => {
    if (!compact && mobileFiltersOpen) discardMobileDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, mobileFiltersOpen]);
  const effectiveViewMode = compact ? "list" : filters.viewMode;
  const resultCount = feed.items.length;

  const {
    isSmallAmountActive,
    toggleSmallAmount,
    isHighRatioActive,
    toggleHighRatio,
    isLingchenActive,
    toggleLingchen,
    sortTabs,
  } = useMarketSort(filters, navigate, activeMetadata);

  const breadcrumbs = game
    ? [{ label: "首页", href: "/" }, { label: game.name }, { label: "租号" }]
    : [{ label: "首页", href: "/" }, { label: "三角洲行动" }, { label: "租号" }];
  const available = activeMetadata?.available ?? false;
  /** 筛选配置未初始化（filterRevision 为空）时，列表不会发起请求，必须给出明确状态而不是一直转圈。 */
  const listingNotOpen = metadata.status === "ready" && (!activeMetadata?.filterRevision || activeMetadata?.reasonCode === "FILTERS_UNCONFIGURED");
  const readyToBrowse = lookupNumber ? filterSourceReady : metadata.status === "ready" && available && restoreReady;
  const resetFilters = () => {
    setResetToken((value) => value + 1);
    navigate({ ...filters, filters: {}, q: null, cursor: null });
  };
  const clearSearch = () => navigate(withFilterChange(filters, { q: null }), { push: true });
  const onFilterChange = useCallback((next: ListingFilters) => navigate(next), [navigate]);
  const refreshResults = useCallback(() => {
    if (!readyToBrowse || refreshing) return;
    setRefreshing(true);
    setReturnSnapshot(null);
    setRecoveryNotice(null);
    navigate(withFilterChange(filters, {}));
    feed.reloadFirstPage();
  }, [feed.reloadFirstPage, filters, navigate, readyToBrowse, refreshing]);
  useEffect(() => {
    if (refreshing && (!readyToBrowse || feed.status !== "loading")) setRefreshing(false);
  }, [feed.status, readyToBrowse, refreshing]);
  const currentError = resultError(feed.error ?? feed.loadMoreError, activeMetadata, lookupNumber !== null);

  const activeTags = useActiveListingTags(filters, activeMetadata, catalog.data, game?.code, navigate);

  return <ServiceShell surface="browse" contextLabel={null} showPageHeading={false} topContent={game?.code === "delta" ? <DeltaBanner /> : null}
    breadcrumbs={breadcrumbs} title={game ? `${game.name}账号租赁` : "三角洲行动账号租赁"}
    description=""
    initialQuery={filters.q ?? ""} onSearch={(value) => navigate(withFilterChange(filters, { q: normalizeListingQuery(value) }), { push: true })}
    searchLabel="在公开账号目录中搜索编号或关键词" searchInputLabel="搜索账号编号或关键词" searchPlaceholder="搜索账号编号或关键词">
    <section className="game-section market-section" aria-label="公开账号市场">
      <div className="market-directory" id="account-list" tabIndex={-1}>
        {!lookupNumber && (metadata.status === "loading" || games.status === "loading") ? <p className="market-state-note" role="status">正在读取当前游戏与可用筛选项…</p> : null}
        {!lookupNumber && metadata.status === "error" ? <div className="market-inline-state" role="alert"><p>筛选配置暂时不可用，账号目录尚未发起请求。</p><button type="button" className="button secondary" onClick={() => setMetadataAttempt((value) => value + 1)}><RotateCw size={15} />重试筛选配置</button></div> : null}
        {!lookupNumber && metadata.status === "ready" && (listingNotOpen || !available) ? <div className="market-inline-state" role="status"><h3>暂未开放选号</h3><p>{listingNotOpen ? "平台正在完成上架配置，稍后即可查看账号。" : "此游戏的账号目录暂不可用，请稍后重试。"}</p>{listingNotOpen ? <button type="button" className="button secondary" onClick={() => setMetadataAttempt((value) => value + 1)}><RotateCw size={15} />重新检查</button> : null}</div> : null}

        {activeMetadata && available && !lookupNumber && <>
          {compact && <div className="market-filter-mobile-row">
            <span>{filterCount ? `已选 ${filterCount} 项条件` : "按资源、属性和皮肤筛选"}</span>
            <Drawer isOpen={mobileFiltersOpen} onOpenChange={(next) => { if (next) openMobileFilters(); else discardMobileDraft(); }}>
              <Drawer.Trigger className="market-mobile-filter-trigger"><SlidersHorizontal size={16} aria-hidden="true" />筛选{filterCount > 0 ? ` · ${filterCount}` : ""}</Drawer.Trigger>
              <Drawer.Backdrop variant="opaque"><Drawer.Content placement="bottom"><Drawer.Dialog className="market-filter-drawer-dialog">
                <div className="market-filter-drawer-header">
                  <button type="button" className="market-drawer-icon-btn" onClick={discardMobileDraft} aria-label="关闭筛选">
                    <X size={18} aria-hidden="true" />
                  </button>
                  <h2 className="market-drawer-title">筛选账号</h2>
                  <div className="market-drawer-header-actions">
                    {activeListingFilterCount(draftFilters ?? filters) > 0 ? (
                      <>
                        <span className="market-drawer-count-badge">已选 {activeListingFilterCount(draftFilters ?? filters)} 项</span>
                        <button type="button" className="market-drawer-clear-btn" onClick={clearMobileDraft}>清空</button>
                      </>
                    ) : (
                      <span className="market-drawer-count-placeholder">未选条件</span>
                    )}
                  </div>
                </div>
                <Drawer.Body className="market-filter-drawer-body">
                  <MarketFilterControls
                    mobile={true}
                    resetToken={draftResetToken}
                    flushDrafts={registerDraftFlusher}
                    filters={draftFilters ?? filters}
                    metadata={activeMetadata}
                    gameCode={game?.code}
                    catalog={catalog.data}
                    catalogStatus={catalog.status}
                    skinSearch={skinSearch}
                    skinOwner={resolvedSkinOwner}
                    skinRarity={resolvedSkinRarity}
                    onSkinOwnerChange={setSkinOwner}
                    onSkinRarityChange={setSkinRarity}
                    activeSkinCategoryId={resolvedSkinCategoryId}
                    skinSearchCatalog={skinSearchCatalog.data}
                    skinSearchStatus={skinSearchCatalog.status}
                    onChange={onDraftChange}
                    onRetryCatalog={() => setCatalogAttempt((value) => value + 1)}
                    onRetrySkinSearch={() => setSkinSearchAttempt((value) => value + 1)}
                    onSkinSearchChange={setSkinSearch}
                    onSkinCategoryChange={(categoryId) => { setActiveSkinCategoryId(categoryId); setSkinOwner(""); }}
                    onLoadMoreSkins={() => void loadMoreSkinSearch()}
                    loadingMoreSkins={loadingMoreSkinSearch}
                  />
                </Drawer.Body>
                <Drawer.Footer className="market-filter-drawer-footer">
                  <div className="market-filter-drawer-actions">
                    <button type="button" className="market-clear-filters" onClick={clearMobileDraft}>重置全部</button>
                    <Button className="market-filter-drawer-apply" variant="primary" onPress={applyMobileDraft}>应用筛选</Button>
                  </div>
                </Drawer.Footer>
              </Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
            </Drawer>
          </div>}
          {!compact && <details
            className="market-filter-details"
            open={filtersOpen}
            onToggle={(event) => {
              filtersOpenTouched.current = true;
              setFiltersOpen(event.currentTarget.open);
            }}
          >
            <summary><span>筛选条件</span>{filterCount > 0
              ? <span className="market-filter-summary-count">已选 {filterCount} 项{filtersOpen ? " · 点击收起" : " · 展开调整"}</span>
              : <span className="market-filter-summary-count">{filtersOpen ? "点击收起筛选条件" : "展开选择资源、属性与皮肤"}</span>}</summary>
            <MarketFilterControls resetToken={resetToken} filters={filters} metadata={activeMetadata} gameCode={game?.code} catalog={catalog.data} catalogStatus={catalog.status} skinSearch={skinSearch} skinOwner={resolvedSkinOwner} skinRarity={resolvedSkinRarity} onSkinOwnerChange={setSkinOwner} onSkinRarityChange={setSkinRarity} activeSkinCategoryId={resolvedSkinCategoryId} skinSearchCatalog={skinSearchCatalog.data} skinSearchStatus={skinSearchCatalog.status} onChange={onFilterChange} onRetryCatalog={() => setCatalogAttempt((value) => value + 1)} onRetrySkinSearch={() => setSkinSearchAttempt((value) => value + 1)} onSkinSearchChange={setSkinSearch} onSkinCategoryChange={(categoryId) => { setActiveSkinCategoryId(categoryId); setSkinOwner(""); }} onLoadMoreSkins={() => void loadMoreSkinSearch()} loadingMoreSkins={loadingMoreSkinSearch} />
            <button type="button" className="market-clear-filters market-clear-top" onClick={resetFilters} disabled={filterCount === 0} aria-disabled={filterCount === 0}>清空筛选</button>
          </details>}
        </>}

        {recoveryNotice && <p className="market-recovery-note" role="status">{recoveryNotice}</p>}
        {catalog.status === "error" && activeMetadata && !lookupNumber ? <p className="market-catalog-note" role="status">皮肤目录暂不可用；已选条件和其他筛选仍可继续使用。</p> : null}
        <FavoriteNotice />
        <MarketResultsToolbar
          lookupNumber={Boolean(lookupNumber)}
          feedStatus={feed.status}
          resultCount={resultCount}
          currentError={currentError}
          listingNotOpen={Boolean(listingNotOpen)}
          readyToBrowse={Boolean(readyToBrowse)}
          hasNextCursor={Boolean(feed.nextCursor)}
          refreshing={refreshing}
          onRefresh={refreshResults}
          compact={compact}
          viewMode={effectiveViewMode}
          onViewModeChange={(mode) => navigate({ ...filters, viewMode: mode })}
        />

        {activeMetadata && !lookupNumber && (
          <MarketSortBar
            isSmallAmountActive={isSmallAmountActive}
            onToggleSmallAmount={toggleSmallAmount}
            isHighRatioActive={isHighRatioActive}
            onToggleHighRatio={toggleHighRatio}
            isLingchenActive={isLingchenActive}
            onToggleLingchen={toggleLingchen}
            sortTabs={sortTabs}
          />
        )}

        {activeTags.length > 0 && feed.items.length > 0 ? (
          <MarketActiveChips
            tags={activeTags}
            expanded={chipsExpanded}
            onToggleExpanded={() => setChipsExpanded((value) => !value)}
            onReset={resetFilters}
          />
        ) : null}
        {filters.q && <div className="market-search-summary" role="status">搜索“{filters.q}” · {lookupNumber ? "按完整编号精确查找" : "按账号标题关键词筛选"}<button type="button" onClick={clearSearch}>清除搜索</button></div>}
        <div className="market-results" aria-busy={feed.status === "loading" || feed.isLoadingMore}>
          {feed.status === "loading" && !listingNotOpen && metadata.status !== "error" ? <div className={`account-grid account-grid--${effectiveViewMode}`}>{Array.from({ length: effectiveViewMode === "grid" ? 8 : 4 }, (_, index) => <AccountCardSkeleton key={index} viewMode={effectiveViewMode} />)}</div> : null}
          {feed.status === "error" && feed.items.length === 0 && currentError ? <div className="market-inline-state" role={currentError.kind === "adjust" ? "alert" : "status"}>
            <h3>{currentError.title}</h3><p>{currentError.description}</p>
            {currentError.kind === "retry" ? <button type="button" className="button secondary" onClick={feed.reload}><RotateCw size={15} />重试</button> : <button type="button" className="button secondary" onClick={lookupNumber ? clearSearch : resetFilters}>{lookupNumber ? "清除编号" : "清空筛选条件"}</button>}
          </div> : null}
          {feed.items.length > 0 && currentError ? <p className="market-inline-state market-inline-state--compact" role="alert"><strong>{currentError.title}</strong> {currentError.description}{currentError.kind === "retry" ? <button type="button" onClick={feed.loadMoreError ? feed.loadMore : feed.reload}>{feed.loadMoreError ? "重试加载" : "重试读取"}</button> : currentError.kind === "adjust" ? <button type="button" onClick={lookupNumber ? clearSearch : resetFilters}>{lookupNumber ? "清除编号" : "清空筛选条件"}</button> : null}</p> : null}
          {feed.items.length > 0 ? <div className={`account-grid account-grid--${effectiveViewMode}`}>
            {feed.items.map((listing, index) => <AccountCard key={listing.id} data={toListingCard(listing)} viewMode={effectiveViewMode} matchedResourceItemIds={matchedResourceItemIds} imageLoading={index < (effectiveViewMode === "grid" ? 8 : 4) ? "eager" : "lazy"} getReturnState={() => ({ scrollY: window.scrollY, pageCursors: feed.requestedCursors.length ? feed.requestedCursors : [null], filterKey, viewMode: effectiveViewMode })} />)}
          </div> : feed.status === "ready" && !feed.nextCursor ? <AccountCardEmpty message="暂时没有符合条件的账号" description={filterCount > 0 ? "可以单项移除条件以逐步放宽范围，或清除全部筛选：" : "当前没有可展示的号源，也可以返回全部账号重新查看："} onReset={resetFilters} resetLabel={filterCount > 0 ? "清除筛选条件" : "返回全部账号"} onRetry={filterCount === 0 ? feed.reload : undefined}>
            {activeTags.length > 0 && <div className="account-empty-filters" role="group" aria-label="当前已选筛选条件">
              <div className="account-empty-chips">
                {activeTags.map((tag) => <button key={tag.id} type="button" className="market-filter-chip account-empty-chip" onClick={tag.onRemove} aria-label={`移除筛选：${tag.label}`}><span>{tag.label}</span><X size={12} aria-hidden="true" /></button>)}
              </div>
            </div>}
          </AccountCardEmpty> : null}
          {feed.status === "ready" && feed.items.length === 0 && feed.nextCursor ? <div className="market-empty-continuation" role="status"><p>这一批没有符合条件的账号，后面还有尚未读取的账号。</p><button type="button" className="button secondary" onClick={feed.loadMore} disabled={feed.isLoadingMore}>{feed.isLoadingMore ? "正在加载…" : "继续查找"}</button></div> : null}
        </div>

        {feed.resumeIncomplete && <p className="market-recovery-note" role="status">列表数据已有更新，已尽量恢复原浏览位置。</p>}
        {feed.status === "ready" && feed.nextCursor ? <>
          <div ref={endRef} className="market-load-sentinel" aria-hidden="true" />
          <div className="market-load-more"><button type="button" className="button secondary" onClick={feed.loadMore} disabled={feed.isLoadingMore}>{feed.isLoadingMore ? "正在加载更多…" : feed.loadMoreError ? "重试加载更多" : "加载更多"}</button><span>{feed.scanBudgetReached ? "本次自动扫描已达服务端预算，可手动继续。" : "滚动至此处会自动继续加载。"}</span></div>
        </> : null}
      </div>
    </section>
  </ServiceShell>;
}
