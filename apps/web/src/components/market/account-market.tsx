"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Drawer } from "@heroui/react";
import useEmblaCarousel from "embla-carousel-react";
import { LayoutGrid, List, RotateCw, SlidersHorizontal, X } from "lucide-react";
import { AccountCard } from "@/components/delta/account-card";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";
import { AccountCardEmpty } from "@/components/delta/account-card-empty";
import { FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { ServiceShell } from "@/components/layout/service-shell";
import { MarketFilterControls, MarketSelect } from "@/components/market/market-filter-controls";
import {
  activeListingFilterCount,
  LISTING_PAGE_SIZE,
  listingFilterKey,
  listingFiltersUrl,
  listingRequestBudget,
  listingRequestBudgetMessage,
  parseListingFilters,
  reconcileListingFilters,
  resourceInputFromBase,
  resourceItemDisplayName,
  resourceUnitShort,
  toggleSkinId,
  withFilterChange,
  normalizeListingQuery,
  type ListingFilters,
} from "@/lib/listing-filters";
import { consumeAccountReturnSnapshot, type AccountReturnSnapshot } from "@/lib/account-return";
import { toListingCard } from "@/lib/listing-view";
import { SupplyRequestError, supplyApi } from "@/lib/supply-client";
import type { PublicCatalog, PublicListingFilterMetadata, SupplyFieldError, SupplyGame } from "@/lib/supply-types";
import { useListingFeed } from "./use-listing-feed";
import "./market.css";

type Directory<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null; error?: SupplyRequestError | null };

function searchParamsRecord(search: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const previous = result[key];
    result[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return result;
}

function DeltaBanner() {
  const [viewport] = useEmblaCarousel({ loop: false, watchDrag: false, watchFocus: false });
  return <div className="market-banner-layout">
    <div className="market-banner-carousel" role="region" aria-roledescription="轮播" aria-label="三角洲行动专区宣传">
      <div className="market-banner-viewport" ref={viewport}>
        <div className="market-banner-track">
          <div className="market-banner-slide" role="group" aria-roledescription="幻灯片" aria-label="三角洲行动资源账号租赁">
            <Link className="market-poster-link" href="#account-list" aria-label="浏览三角洲资源账号">
              <img src="/art/zhouzhou/delta-section-banner-poster-v3.png" alt="" fetchPriority="high" />
            </Link>
          </div>
        </div>
      </div>
    </div>
    <div className="market-contact-templates" aria-label="联系二维码">
      <img src="/art/zhouzhou/group-qr-card-v3.png" alt="玩家交流群二维码暂未配置" />
      <img src="/art/zhouzhou/cooperation-qr-card-v3.png" alt="合作咨询二维码暂未配置" />
    </div>
  </div>;
}

export function AccountMarket({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const initialFilters = parseListingFilters(searchParams);
  return <FavoritesProvider><MarketView initialFilters={initialFilters} /></FavoritesProvider>;
}

function errorForPath(details: SupplyFieldError[], metadata: PublicListingFilterMetadata | null): string[] {
  return details.map((detail) => {
    const label = metadata?.fields.find((entry) => detail.path.toLowerCase().includes(entry.key.toLowerCase()))?.label;
    return `${label ?? "筛选条件"}：请检查或移除该条件后重试。`;
  }).filter((message, index, all) => all.indexOf(message) === index);
}

function resultError(error: { status: number; code: string; details: SupplyFieldError[]; message?: string } | null, metadata: PublicListingFilterMetadata | null): { title: string; description: string; kind: "retry" | "adjust" } | null {
  if (!error) return null;
  if (error.code === "LISTING_URL_TOO_LONG") return { title: "筛选条件过多，未发起请求", description: error.message ?? "请减少部分筛选条件后重试。", kind: "adjust" };
  if (error.status === 400) return { title: "有筛选条件未被接受", description: errorForPath(error.details, metadata).join(" ") || "请检查筛选条件后重试。", kind: "adjust" };
  if (error.status === 409) return { title: "筛选规则刚刚更新", description: "已尝试刷新可用条件；如仍无法读取，请重试。", kind: "retry" };
  if (error.status === 503) return { title: "账号目录暂不可用", description: "服务恢复后可继续浏览，当前筛选条件会保留。", kind: "retry" };
  return { title: "账号列表加载失败", description: "请检查网络连接后重试。", kind: "retry" };
}

function MarketView({ initialFilters }: { initialFilters: ListingFilters }) {
  const [filters, setFilters] = useState(initialFilters);
  const [filterSourceReady, setFilterSourceReady] = useState(false);
  const [games, setGames] = useState<Directory<SupplyGame[]>>({ status: "loading", data: null });
  const [metadata, setMetadata] = useState<Directory<PublicListingFilterMetadata>>({ status: filters.game ? "loading" : "idle", data: null });
  const [catalog, setCatalog] = useState<Directory<PublicCatalog>>({ status: "idle", data: null });
  const [skinSearchCatalog, setSkinSearchCatalog] = useState<Directory<PublicCatalog>>({ status: "idle", data: null });
  const [skinSearch, setSkinSearch] = useState("");
  const [activeSkinCategoryId, setActiveSkinCategoryId] = useState("");
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [skinSearchAttempt, setSkinSearchAttempt] = useState(0);
  const [loadingMoreSkins, setLoadingMoreSkins] = useState(false);
  const [loadingMoreSkinSearch, setLoadingMoreSkinSearch] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [restoreReady, setRestoreReady] = useState(false);
  const [returnSnapshot, setReturnSnapshot] = useState<AccountReturnSnapshot | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const metadataRefreshed = useRef<string | null>(null);
  const invalidCursorHandled = useRef<string | null>(null);
  const catalogSequence = useRef(0);
  const catalogController = useRef<AbortController | null>(null);
  const catalogBusy = useRef(false);
  const skinSearchSequence = useRef(0);
  const skinSearchController = useRef<AbortController | null>(null);
  const skinSearchBusy = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const initialRestoreDone = useRef(false);
  const rejectedSharePathRef = useRef<string | null>(null);
  const activeMetadata = metadata.status === "ready" ? metadata.data : null;
  const filterKey = listingFilterKey(filters, activeMetadata);
  const configuredSkinCategoryIds = new Set(activeMetadata?.fields.find((entry) => entry.key === "skinGroups")?.categoryIds ?? []);
  const skinCategories = (catalog.data?.categories ?? []).filter((category) => configuredSkinCategoryIds.has(category.id));
  const resolvedSkinCategoryId = skinCategories.some((category) => category.id === activeSkinCategoryId)
    ? activeSkinCategoryId
    : skinCategories[0]?.id ?? "";
  const normalizedSkinSearch = skinSearch.normalize("NFKC").trim().slice(0, 80);
  const feed = useListingFeed(filters, metadata.data, {
    enabled: restoreReady && metadata.status === "ready" && Boolean(metadata.data?.available),
    replayCursors: returnSnapshot?.filterKey === filterKey ? returnSnapshot.pageCursors : undefined,
  });


  const navigate = useCallback((next: ListingFilters) => {
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
      window.history.replaceState(window.history.state, "", address);
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
    if (games.status === "ready" && !filters.game && games.data?.length === 1) navigate({ ...filters, game: games.data[0]!.id });
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
    supplyApi.browseCatalog(filters.game, new URLSearchParams({ limit: "100" }), controller.signal).then((data) => {
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
    if (!filters.game || !query || !categoryId) {
      skinSearchSequence.current += 1;
      setSkinSearchCatalog({ status: "idle", data: null });
      return;
    }

    const controller = new AbortController();
    const requestId = ++skinSearchSequence.current;
    skinSearchController.current = controller;
    setSkinSearchCatalog({ status: "loading", data: null });
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "100", q: query, categoryId });
      supplyApi.browseCatalog(filters.game!, params, controller.signal).then((data) => {
        if (controller.signal.aborted || requestId !== skinSearchSequence.current) return;
        setSkinSearchCatalog({ status: "ready", data });
        if (skinSearchController.current === controller) skinSearchController.current = null;
      }).catch((error: unknown) => {
        if (controller.signal.aborted || requestId !== skinSearchSequence.current) return;
        setSkinSearchCatalog({ status: "error", data: null, error: error instanceof SupplyRequestError ? error : null });
        if (skinSearchController.current === controller) skinSearchController.current = null;
      });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (skinSearchController.current === controller) skinSearchController.current = null;
      if (requestId === skinSearchSequence.current) skinSearchSequence.current += 1;
    };
  }, [filters.game, normalizedSkinSearch, resolvedSkinCategoryId, skinSearchAttempt]);

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
      setRecoveryNotice("已按当前服务端规则保留仍有效的筛选条件。");
      setFilters(reconciled);
    }
    if (!initialRestoreDone.current) {
      initialRestoreDone.current = true;
      const address = listingFiltersUrl(reconciled);
      const budget = listingRequestBudget(reconciled, metadata.data, null);
      if (budget) setRecoveryNotice(listingRequestBudgetMessage(budget));
      else if (window.location.pathname + window.location.search !== address && !changed) setRecoveryNotice("链接中的部分参数不可用，已保留仍合法的筛选条件。");
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

  const conflictStatus = feed.error?.status === 409 ? 409 : feed.loadMoreError?.status === 409 ? 409 : null;
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

  const loadMoreSkins = useCallback(async () => {
    const current = catalog.data;
    if (!filters.game || !current?.nextCursor || catalogBusy.current) return;
    const requestId = catalogSequence.current;
    const controller = new AbortController();
    catalogController.current?.abort();
    catalogController.current = controller;
    catalogBusy.current = true;
    setLoadingMoreSkins(true);
    try {
      const page = await supplyApi.browseCatalog(filters.game, new URLSearchParams({ limit: "100", cursor: current.nextCursor }), controller.signal);
      if (controller.signal.aborted || requestId !== catalogSequence.current) return;
      setCatalog((previous) => {
        if (!previous.data || previous.data.game.id !== filters.game) return previous;
        const ids = new Set(previous.data.skins.map((skin) => skin.id));
        return { ...previous, data: { ...previous.data, skins: [...previous.data.skins, ...page.skins.filter((skin) => !ids.has(skin.id))], nextCursor: page.nextCursor === current.nextCursor ? null : page.nextCursor } };
      });
    } catch {
      if (!controller.signal.aborted) {
        setRecoveryNotice("更多皮肤加载失败，已加载的类别与皮肤仍可继续筛选；可再次加载。");
        setCatalog((previous) => ({ ...previous, status: previous.data ? "ready" : "error" }));
      }
    } finally {
      if (requestId === catalogSequence.current) {
        catalogBusy.current = false;
        setLoadingMoreSkins(false);
        if (catalogController.current === controller) catalogController.current = null;
      }
    }
  }, [catalog.data, filters.game]);

  const loadMoreSkinSearch = useCallback(async () => {
    const current = skinSearchCatalog.data;
    const query = normalizedSkinSearch;
    const categoryId = resolvedSkinCategoryId;
    const cursor = current?.nextCursor;
    if (!filters.game || !query || !categoryId || !cursor || skinSearchBusy.current) return;
    const requestId = skinSearchSequence.current;
    const controller = new AbortController();
    skinSearchController.current?.abort();
    skinSearchController.current = controller;
    skinSearchBusy.current = true;
    setLoadingMoreSkinSearch(true);
    try {
      const params = new URLSearchParams({ limit: "100", q: query, categoryId, cursor });
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
  }, [filters.game, normalizedSkinSearch, resolvedSkinCategoryId, skinSearchCatalog.data]);

  const game = catalog.data?.game ?? games.data?.find((entry) => entry.id === filters.game) ?? null;
  const filterCount = activeListingFilterCount(filters);
  const resultCount = feed.items.length;
  const sortOptions = useMemo(() => activeMetadata?.sorts.filter((sort) => sort.enabled).sort((a, b) => a.order - b.order) ?? [], [activeMetadata]);
  const selectedSort = activeMetadata?.sorts.find((sort) => sort.key === filters.sort);
  const coreOptions = selectedSort?.itemIds?.map((id) => activeMetadata?.items.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item)) ?? [];
  const breadcrumbs = game
    ? [{ label: "首页", href: "/" }, { label: game.name }, { label: "租号" }]
    : [{ label: "首页", href: "/" }, { label: "三角洲行动" }, { label: "租号" }];
  const available = activeMetadata?.available ?? false;
  const readyToBrowse = metadata.status === "ready" && available && restoreReady;
  const resetFilters = () => navigate({ ...filters, filters: {}, q: null, cursor: null });
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
  const currentError = resultError(feed.error ?? feed.loadMoreError, activeMetadata);

  const activeTags = useMemo(() => {
    if (!activeMetadata || filterCount === 0) return [];
    const tags: { id: string; label: string; onRemove: () => void }[] = [];
    const selected = filters.filters;
    if (filters.q) {
      tags.push({
        id: "q",
        label: `搜索: ${filters.q}`,
        onRemove: () => navigate(withFilterChange(filters, { q: null })),
      });
    }
    const safeBoxField = activeMetadata.fields.find((f) => f.key === "safeBoxCodes");
    for (const code of selected.safeBoxCodes ?? []) {
      const label = safeBoxField?.options?.find((o) => o.value === code)?.label ?? code;
      tags.push({
        id: `safeBox-${code}`,
        label: `安全箱: ${label}`,
        onRemove: () => {
          const next = (selected.safeBoxCodes ?? []).filter((c) => c !== code);
          navigate(withFilterChange(filters, { filters: { ...selected, safeBoxCodes: next.length ? next : undefined } }));
        },
      });
    }
    const gradingField = activeMetadata.fields.find((f) => f.key === "gradingCodes");
    for (const code of selected.gradingCodes ?? []) {
      const label = gradingField?.options?.find((o) => o.value === code)?.label ?? code;
      tags.push({
        id: `grading-${code}`,
        label: `段位: ${label}`,
        onRemove: () => {
          const next = (selected.gradingCodes ?? []).filter((c) => c !== code);
          navigate(withFilterChange(filters, { filters: { ...selected, gradingCodes: next.length ? next : undefined } }));
        },
      });
    }
    const loginField = activeMetadata.fields.find((f) => f.key === "loginMethodCodes");
    for (const code of selected.loginMethodCodes ?? []) {
      const label = loginField?.options?.find((o) => o.value === code)?.label ?? code;
      tags.push({
        id: `login-${code}`,
        label: `登录: ${label}`,
        onRemove: () => {
          const next = (selected.loginMethodCodes ?? []).filter((c) => c !== code);
          navigate(withFilterChange(filters, { filters: { ...selected, loginMethodCodes: next.length ? next : undefined } }));
        },
      });
    }
    if (selected.vitality) {
      tags.push({
        id: "vitality",
        label: `体力 ≥ ${selected.vitality.min}`,
        onRemove: () => navigate(withFilterChange(filters, { filters: { ...selected, vitality: undefined } })),
      });
    }
    if (selected.bear) {
      tags.push({
        id: "bear",
        label: `负重 ≥ ${selected.bear.min}`,
        onRemove: () => navigate(withFilterChange(filters, { filters: { ...selected, bear: undefined } })),
      });
    }
    if (selected.serviceWindow) {
      const sw = selected.serviceWindow;
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      tags.push({
        id: "serviceWindow",
        label: `时段: ${fmt(sw.startMinute)}—${sw.crossMidnight ? "次日 " : ""}${fmt(sw.endMinute)}`,
        onRemove: () => navigate(withFilterChange(filters, { filters: { ...selected, serviceWindow: undefined } })),
      });
    }
    for (const region of selected.regions ?? []) {
      tags.push({
        id: `region-${region.province}-${region.city}`,
        label: `${region.province}·${region.city}`,
        onRemove: () => {
          const next = (selected.regions ?? []).filter((r) => r.province !== region.province || r.city !== region.city);
          navigate(withFilterChange(filters, { filters: { ...selected, regions: next.length ? next : undefined } }));
        },
      });
    }
    for (const res of selected.resources ?? []) {
      const item = activeMetadata.items.find((i) => i.id === res.itemId);
      const name = item?.unit === "HAFF_BASE" ? "哈夫币" : resourceItemDisplayName(item, { gameCode: game?.code, itemId: res.itemId });
      const display = (value: string) => {
        const quantity = item ? resourceInputFromBase(value, item) ?? value : value;
        const unit = item ? resourceUnitShort(item) : "";
        return unit ? `${quantity} ${unit}` : quantity;
      };
      const rangeLabel = res.minQuantity !== undefined && res.maxQuantity !== undefined
        ? res.minQuantity === res.maxQuantity ? display(res.minQuantity) : `${display(res.minQuantity)}–${display(res.maxQuantity)}`
        : res.minQuantity !== undefined ? `≥ ${display(res.minQuantity)}` : `≤ ${display(res.maxQuantity!)}`;
      tags.push({
        id: `resource-${res.itemId}`,
        label: `${name}: ${rangeLabel}`,
        onRemove: () => {
          const next = (selected.resources ?? []).filter((r) => r.itemId !== res.itemId);
          navigate(withFilterChange(filters, { filters: { ...selected, resources: next.length ? next : undefined } }));
        },
      });
    }
    for (const group of selected.skinGroups ?? []) {
      for (const skinId of group.ids) {
        const skinName = catalog.data?.skins?.find((s) => s.id === skinId)?.name ?? "已选皮肤";
        tags.push({
          id: `skin-${skinId}`,
          label: `皮肤: ${skinName}`,
          onRemove: () => navigate(toggleSkinId(filters, group.categoryId, skinId)),
        });
      }
    }
    return tags;
  }, [activeMetadata, catalog.data, filterCount, filters, game?.code, navigate]);

  return <ServiceShell surface="browse" contextLabel={null} showPageHeading={false} topContent={game?.code === "delta" ? <DeltaBanner /> : null}
    breadcrumbs={breadcrumbs} title={game ? `${game.name}账号租赁` : "三角洲行动账号租赁"}
    description=""
    initialQuery={filters.q ?? ""} onSearch={(value) => navigate(withFilterChange(filters, { q: normalizeListingQuery(value) }))}
    searchLabel="在公开账号目录中搜索账号名称" searchInputLabel="搜索账号名称" searchPlaceholder="搜索账号名称">
    <section className="game-section market-section" aria-label="公开账号市场">
      <div className="market-directory" id="account-list" tabIndex={-1}>
        {metadata.status === "loading" || games.status === "loading" ? <p className="market-state-note" role="status">正在读取当前游戏与可用筛选项…</p> : null}
        {metadata.status === "error" ? <div className="market-inline-state" role="alert"><p>筛选配置暂时不可用，账号目录尚未发起请求。</p><button type="button" className="button secondary" onClick={() => setMetadataAttempt((value) => value + 1)}><RotateCw size={15} />重试筛选配置</button></div> : null}
        {metadata.status === "ready" && !available ? <div className="market-inline-state" role="status"><h3>当前游戏暂不可筛选</h3><p>服务端尚未开放此游戏的公开账号筛选配置。</p></div> : null}

        {activeMetadata && available && <>
          <div className="market-filter-mobile-row">
            <span>{filterCount ? `已选 ${filterCount} 项条件` : "按资源、属性和皮肤筛选"}</span>
            <Drawer isOpen={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
              <Drawer.Trigger className="market-mobile-filter-trigger"><SlidersHorizontal size={16} aria-hidden="true" />筛选{filterCount > 0 ? ` · ${filterCount}` : ""}</Drawer.Trigger>
              <Drawer.Backdrop variant="opaque"><Drawer.Content placement="bottom"><Drawer.Dialog className="market-filter-drawer-dialog">
                <Drawer.Handle />
                <Drawer.CloseTrigger className="market-filter-drawer-close" aria-label="关闭筛选"><X size={18} aria-hidden="true" /></Drawer.CloseTrigger>
                <Drawer.Header><Drawer.Heading>筛选账号</Drawer.Heading></Drawer.Header>
              <Drawer.Body><MarketFilterControls filters={filters} metadata={activeMetadata} gameCode={game?.code} catalog={catalog.data} catalogStatus={catalog.status} skinSearch={skinSearch} activeSkinCategoryId={resolvedSkinCategoryId} skinSearchCatalog={skinSearchCatalog.data} skinSearchStatus={skinSearchCatalog.status} onChange={onFilterChange} onRetryCatalog={() => setCatalogAttempt((value) => value + 1)} onRetrySkinSearch={() => setSkinSearchAttempt((value) => value + 1)} onSkinSearchChange={setSkinSearch} onSkinCategoryChange={setActiveSkinCategoryId} onLoadMoreSkins={() => void (normalizedSkinSearch ? loadMoreSkinSearch() : loadMoreSkins())} loadingMoreSkins={normalizedSkinSearch ? loadingMoreSkinSearch : loadingMoreSkins} /></Drawer.Body>
                <Drawer.Footer className="market-filter-drawer-footer"><div className="market-filter-drawer-actions">
                  <button type="button" className="market-clear-filters" disabled={filterCount === 0} onClick={resetFilters}>清空筛选</button>
                  <Button className="market-filter-drawer-apply" variant="primary" onPress={() => setMobileFiltersOpen(false)}>返回结果</Button>
                </div></Drawer.Footer>
              </Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
            </Drawer>
          </div>
          <details className="market-filter-details" open>
            <summary><span>筛选条件</span>{filterCount > 0 ? <span className="market-filter-summary-count">已选 {filterCount} 项</span> : <span className="market-filter-summary-count">展开选择资源、属性与皮肤</span>}</summary>
            <MarketFilterControls filters={filters} metadata={activeMetadata} gameCode={game?.code} catalog={catalog.data} catalogStatus={catalog.status} skinSearch={skinSearch} activeSkinCategoryId={resolvedSkinCategoryId} skinSearchCatalog={skinSearchCatalog.data} skinSearchStatus={skinSearchCatalog.status} onChange={onFilterChange} onRetryCatalog={() => setCatalogAttempt((value) => value + 1)} onRetrySkinSearch={() => setSkinSearchAttempt((value) => value + 1)} onSkinSearchChange={setSkinSearch} onSkinCategoryChange={setActiveSkinCategoryId} onLoadMoreSkins={() => void (normalizedSkinSearch ? loadMoreSkinSearch() : loadMoreSkins())} loadingMoreSkins={normalizedSkinSearch ? loadingMoreSkinSearch : loadingMoreSkins} />
            <button type="button" className="market-clear-filters market-clear-top" disabled={filterCount === 0} onClick={resetFilters}>清空筛选</button>
          </details>
        </>}

        {recoveryNotice && <p className="market-recovery-note" role="status">{recoveryNotice}</p>}
        {catalog.status === "error" && activeMetadata ? <p className="market-catalog-note" role="status">皮肤目录暂不可用；已选条件和其他筛选仍可继续使用。</p> : null}
        <FavoriteNotice />

        <div className="market-results-toolbar">
          <div><h2>可租账号</h2><p>{feed.status === "ready" ? `已加载 ${resultCount} 个结果` : feed.status === "error" ? "结果读取失败" : "正在读取结果"}{feed.nextCursor ? " · 还有更多可继续加载" : ""}</p></div>
          <div className="market-results-controls">
            {activeMetadata && <div className="market-sort-controls" aria-label="账号排序">
              <div className="market-sort-field"><span>排序</span><MarketSelect
                className="market-ui-select--toolbar"
                label="排序"
                value={filters.sort}
                placeholder="排序方式"
                options={sortOptions.map((sort) => ({ value: sort.key, label: sort.label }))}
                onChange={(key) => {
                if (!key) return;
                const config = activeMetadata.sorts.find((entry) => entry.key === key);
                const nextDirection = activeMetadata.directions.includes(filters.direction) ? filters.direction : activeMetadata.defaultSort.direction;
                navigate(withFilterChange(filters, { sort: key, direction: nextDirection, coreItemId: key === "coreQuantity" ? config?.itemIds?.[0] ?? null : null }));
              }} /></div>
              {activeMetadata.directions.length > 1 && <div className="market-sort-field"><span>方向</span><MarketSelect
                className="market-ui-select--toolbar"
                label="排序方向"
                value={filters.direction}
                placeholder="排序方向"
                options={activeMetadata.directions.map((direction) => ({ value: direction, label: direction === "ASC" ? "升序" : "降序" }))}
                onChange={(direction) => { if (direction) navigate(withFilterChange(filters, { direction: direction as ListingFilters["direction"] })); }}
              /></div>}
              {filters.sort === "coreQuantity" && <div className="market-sort-field"><span>核心资源</span><MarketSelect
                className="market-ui-select--toolbar"
                label="核心资源"
                value={filters.coreItemId}
                placeholder="选择资源"
                options={coreOptions.map((item) => ({ value: item.id, label: resourceItemDisplayName(item, { gameCode: game?.code, itemId: item.id }) }))}
                onChange={(coreItemId) => navigate(withFilterChange(filters, { coreItemId }))}
              /></div>}
            </div>}
            <div className="market-results-actions">
              <button type="button" className="market-toolbar-action" onClick={refreshResults} disabled={!readyToBrowse || refreshing} aria-busy={refreshing || undefined}><RotateCw size={15} aria-hidden="true" />{refreshing ? "刷新中…" : "刷新结果"}</button>
            </div>
            <div className="market-view-toggle" role="group" aria-label="账号展示方式">
              <button type="button" aria-pressed={filters.viewMode === "list"} onClick={() => navigate({ ...filters, viewMode: "list" })}><List size={16} aria-hidden="true" /><span>列表</span></button>
              <button type="button" aria-pressed={filters.viewMode === "grid"} onClick={() => navigate({ ...filters, viewMode: "grid" })}><LayoutGrid size={16} aria-hidden="true" /><span>卡片</span></button>
            </div>
          </div>
        </div>


        {filters.q && <div className="market-search-summary" role="status">搜索“{filters.q}” · 由服务端按公开账号名称筛选<button type="button" onClick={() => navigate(withFilterChange(filters, { q: null }))}>清除搜索</button></div>}
        {feed.status === "ready" && feed.items.length > 0 && <div className="market-trust-note" role="note">公开浏览无需登录 · 报价取自服务端当前 quote · 未确认的信息会明确标注</div>}
        <div className="market-results" aria-busy={feed.status === "loading" || feed.isLoadingMore}>
          {feed.status === "loading" ? <div className={`account-grid account-grid--${filters.viewMode}`}>{Array.from({ length: 5 }, (_, index) => <AccountCardSkeleton key={index} />)}</div> : null}
          {feed.status === "error" && feed.items.length === 0 && currentError ? <div className="market-inline-state" role={currentError.kind === "adjust" ? "alert" : "status"}>
            <h3>{currentError.title}</h3><p>{currentError.description}</p>
            {currentError.kind === "retry" ? <button type="button" className="button secondary" onClick={feed.reload}><RotateCw size={15} />重试</button> : <button type="button" className="button secondary" onClick={resetFilters}>清空筛选条件</button>}
          </div> : null}
          {feed.items.length > 0 && currentError ? <p className="market-inline-state market-inline-state--compact" role="alert"><strong>{currentError.title}</strong> {currentError.description}{currentError.kind === "retry" ? <button type="button" onClick={feed.loadMoreError ? feed.loadMore : feed.reload}>{feed.loadMoreError ? "重试加载" : "重试读取"}</button> : currentError.kind === "adjust" ? <button type="button" onClick={resetFilters}>清空筛选条件</button> : null}</p> : null}
          {feed.items.length > 0 ? <div className={`account-grid account-grid--${filters.viewMode}`}>
            {feed.items.map((listing) => <AccountCard key={listing.id} data={toListingCard(listing)} getReturnState={() => ({ scrollY: window.scrollY, pageCursors: feed.requestedCursors.length ? feed.requestedCursors : [null], filterKey, viewMode: filters.viewMode })} />)}
          </div> : feed.status === "ready" && !feed.nextCursor ? <AccountCardEmpty message={filterCount > 0 ? "没有符合条件的账号" : "暂无可租账号"} description={filterCount > 0 ? "可以单项移除条件以逐步放宽范围，或重置全部条件：" : "当前没有可展示的号源，请稍后再来。"} onReset={filterCount > 0 ? resetFilters : undefined} onRetry={filterCount === 0 ? feed.reload : undefined}>
            {activeTags.length > 0 && <div className="account-empty-filters" role="group" aria-label="当前已选筛选条件">
              <div className="account-empty-chips">
                {activeTags.map((tag) => <button key={tag.id} type="button" className="market-filter-chip account-empty-chip" onClick={tag.onRemove} aria-label={`移除筛选：${tag.label}`}><span>{tag.label}</span><X size={12} aria-hidden="true" /></button>)}
              </div>
            </div>}
          </AccountCardEmpty> : null}
          {feed.status === "ready" && feed.items.length === 0 && feed.nextCursor ? <div className="market-empty-continuation" role="status"><p>当前批次没有匹配项，服务端仍提供后续 cursor。</p><button type="button" className="button secondary" onClick={feed.loadMore} disabled={feed.isLoadingMore}>{feed.isLoadingMore ? "正在加载…" : "继续查找"}</button></div> : null}
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
