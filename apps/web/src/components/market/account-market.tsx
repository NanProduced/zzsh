"use client";
import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Drawer } from "@heroui/react";
import { Crosshair, SlidersHorizontal, X } from "lucide-react";
import { AccountCard } from "@/components/delta/account-card";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";
import { AccountCardEmpty } from "@/components/delta/account-card-empty";
import { ActionFeedbackDialog } from "@/components/ui/action-feedback-dialog";
import { FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { ServiceShell } from "@/components/layout/service-shell";
import {
  activeListingFilterCount,
  listingFilterKey,
  listingFiltersUrl,
  parseListingFilters,
  toggleSkinId,
  withFilterChange,
  normalizeListingQuery,
  type ListingFilters,
} from "@/lib/listing-filters";
import { toListingCard } from "@/lib/listing-view";
import { supplyApi } from "@/lib/supply-client";
import type { PublicCatalog, SupplyGame } from "@/lib/supply-types";
import { useListingFeed } from "./use-listing-feed";
import "./market.css";

type Directory<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null };

export function AccountMarket({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = parseListingFilters(searchParams);
  const filterKey = listingFilterKey(filters);
  return <FavoritesProvider>
    <MarketView filters={filters} filterKey={filterKey} />
  </FavoritesProvider>;
}

function MarketView({ filters, filterKey }: { filters: ListingFilters; filterKey: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [games, setGames] = useState<Directory<SupplyGame[]>>({ status: "loading", data: null });
  const [catalog, setCatalog] = useState<Directory<PublicCatalog>>({ status: "idle", data: null });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [minQtyDraft, setMinQtyDraft] = useState(filters.minQty ?? "");
  const [minQtyError, setMinQtyError] = useState<string | null>(null);
  const [skinsLoading, setSkinsLoading] = useState(false);
  const [notice, setNotice] = useState({ isOpen: false, title: "", message: "" });
  const [cursorTrail, setCursorTrail] = useState<(string | null)[]>([filters.cursor]);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const filterKeyRef = useRef(filterKey);
  const gameRef = useRef(filters.game);
  const skinsBusy = useRef(false);
  const feed = useListingFeed(filters);
  gameRef.current = filters.game;

  const navigate = useCallback((next: ListingFilters) => {
    startTransition(() => router.push(listingFiltersUrl(next)));
  }, [router, startTransition]);
  useEffect(() => {
    setMinQtyDraft(filters.minQty ?? "");
    setMinQtyError(null);
  }, [filters.minQty]);
  useEffect(() => {
    setCursorTrail((prev) => {
      if (filterKeyRef.current !== filterKey) {
        filterKeyRef.current = filterKey;
        return [filters.cursor];
      }
      const index = prev.indexOf(filters.cursor);
      return index >= 0 ? prev.slice(0, index + 1) : [...prev, filters.cursor];
    });
  }, [filterKey, filters.cursor]);

  useEffect(() => {
    if (!feed.cursorInvalid || !filters.cursor) return;
    startTransition(() => router.replace(listingFiltersUrl(withFilterChange(filters, {}))));
  }, [feed.cursorInvalid, filters.cursor, router, startTransition]);

  useEffect(() => {
    const controller = new AbortController();
    supplyApi
      .games(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setGames({ status: "ready", data: data.games });
        if (!filters.game && data.games.length === 1)
          router.replace(listingFiltersUrl({ ...filters, game: data.games[0]!.id }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setGames({ status: "error", data: null });
      });
    return () => controller.abort();
    // Mount-only: the default game redirect is an initial URL normalization.
  }, []);

  useEffect(() => {
    if (!filters.game) {
      setCatalog({ status: "idle", data: null });
      return;
    }
    const controller = new AbortController();
    setCatalog({ status: "loading", data: null });
    supplyApi
      .browseCatalog(filters.game, new URLSearchParams({ limit: "100" }), controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setCatalog({ status: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalog({ status: "error", data: null });
      });
    return () => controller.abort();
  }, [filters.game, catalogAttempt]);

  const loadMoreSkins = useCallback(async () => {
    const game = gameRef.current;
    if (!game || !catalog.data?.nextCursor || skinsBusy.current) return;
    skinsBusy.current = true;
    setSkinsLoading(true);
    try {
      const page = await supplyApi.browseCatalog(game, new URLSearchParams({ limit: "100", cursor: catalog.data.nextCursor }));
      if (gameRef.current !== game) return;
      setCatalog((prev) => prev.data ? { ...prev, data: { ...prev.data, skins: [...prev.data.skins, ...page.skins], nextCursor: page.nextCursor } } : prev);
    } catch {
      if (gameRef.current === game) setNotice({ isOpen: true, title: "皮肤列表加载失败", message: "请稍后重试，或继续使用已加载的皮肤筛选。" });
    } finally {
      skinsBusy.current = false;
      setSkinsLoading(false);
    }
  }, [catalog.data]);

  const game = games.data?.find((entry) => entry.id === filters.game) ?? null;
  const items = feed.status === "ready" ? feed.items : [];
  const visible = items;
  const filterCount = activeListingFilterCount(filters);
  const trailIndex = cursorTrail.indexOf(filters.cursor);
  const canPrev = trailIndex > 0;
  const canNext = Boolean(feed.nextCursor) && feed.status === "ready";
  const busy = pending || feed.status === "loading";
  const itemOptions = catalog.data?.items ?? [];
  const mobileFilterFormId = "market-mobile-filters";
  const activeFilterSummary = [
    filters.item ? itemOptions.find((item) => item.id === filters.item)?.name ?? "资源项目" : null,
    filters.minQty ? `最低 ${filters.minQty}` : null,
    filters.skinIds.length ? `${filters.skinIds.length} 款皮肤` : null,
    filters.q ? `搜索“${filters.q}”` : null,
  ].filter((value): value is string => Boolean(value));

  const applyMinQty = (event: FormEvent<HTMLFormElement>): boolean => {
    event.preventDefault();
    const value = minQtyDraft.normalize("NFKC").replace(/[\s,]/g, "");
    if (!value) {
      setMinQtyError(null);
      if (filters.minQty) navigate(withFilterChange(filters, { minQty: null }));
      return true;
    }
    if (!/^\d{1,24}$/.test(value)) {
      setMinQtyError("请填写不超过24位的整数数量（基础单位）。");
      return false;
    }
    setMinQtyError(null);
    if (value !== filters.minQty) navigate(withFilterChange(filters, { minQty: value }));
    return true;
  };
  const applyMobileFilters = (event: FormEvent<HTMLFormElement>) => {
    if (feed.status === "loading" || pending) {
      event.preventDefault();
      return;
    }
    if (feed.status === "error") {
      event.preventDefault();
      feed.reload();
      return;
    }
    if (applyMinQty(event)) setMobileFiltersOpen(false);
  };

  const resetFilters = () => {
    setMinQtyError(null);
    navigate(withFilterChange(filters, { item: null, minQty: null, skinIds: [], match: "ANY", q: null }));
  };
  const skinOptions = catalog.data?.skins ?? [];
  const catalogUnavailable = Boolean(filters.game) && catalog.status === "error";
  const breadcrumbs = game ? [{ label: "首页", href: "/" }, { label: game.name }, { label: "租账号" }] : [{ label: "首页", href: "/" }, { label: "租账号" }];
  const renderFilterFields = (idSuffix: "desktop" | "mobile") => {
    const minQtyErrorId = `market-min-qty-error-${idSuffix}`;
    return <>
    <fieldset>
      <legend className="sr-only">筛选条件</legend>
      <label className="filter-field">游戏
        <select value={filters.game ?? ""} disabled={games.status !== "ready" || (games.data?.length ?? 0) < 2} onChange={(event) => navigate(withFilterChange(filters, { game: event.target.value || null, item: null, minQty: null, skinIds: [], match: "ANY" }))}>
          {!filters.game && <option value="">全部游戏</option>}
          {(games.data ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          {filters.game && !game && <option value={filters.game}>当前游戏</option>}
        </select>
      </label>
      <label className="filter-field">资源项目
        <select value={filters.item ?? ""} disabled={!filters.game || catalog.status === "loading" || catalogUnavailable} onChange={(event) => navigate(withFilterChange(filters, { item: event.target.value || null, minQty: event.target.value ? filters.minQty : null }))}>
          <option value="">全部项目</option>
          {itemOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          {filters.item && !itemOptions.some((item) => item.id === filters.item) && <option value={filters.item}>当前项目</option>}
        </select>
      </label>
      <label className="filter-field">最低数量（基础单位）
        <span className="filter-inline">
          <input inputMode="numeric" value={minQtyDraft} maxLength={24} disabled={!filters.item} placeholder={filters.item ? "如 20000000" : "先选择资源项目"} onChange={(event) => setMinQtyDraft(event.target.value)} aria-describedby={minQtyError ? minQtyErrorId : undefined} />
          <button type="submit" className="button secondary" disabled={!filters.item}>应用数量</button>
        </span>
        {minQtyError && <small id={minQtyErrorId} role="alert" className="filter-error">{minQtyError}</small>}
      </label>
    </fieldset>
    <div className="filter-block">
      <span className="filter-block-heading">展示皮肤{skinOptions.length > 0 ? `（已加载 ${skinOptions.length} 款）` : ""}</span>
      {catalogUnavailable ? <div className="filter-error-row"><p className="filter-error" role="status">皮肤与项目目录暂时不可用，可稍后重试或先按其他条件浏览。</p><button type="button" className="button secondary filter-retry" onClick={() => setCatalogAttempt((value) => value + 1)}>重试资源目录</button></div> : null}
      <div className="skin-chips" role="group" aria-label="按展示皮肤筛选">
        {catalog.status === "loading" && <span className="filter-hint" role="status">正在读取皮肤目录…</span>}
        {skinOptions.map((skin) => {
          const selected = filters.skinIds.includes(skin.id);
          return <button key={skin.id} type="button" className="skin-chip" aria-pressed={selected} onClick={() => navigate(toggleSkinId(filters, skin.id))}>{skin.name}</button>;
        })}
        {catalog.status === "ready" && skinOptions.length === 0 && <span className="filter-hint">当前没有可筛选的皮肤。</span>}
        {catalog.data?.nextCursor && <button type="button" className="skin-chip skin-chip--more" onClick={() => void loadMoreSkins()} disabled={skinsLoading}>{skinsLoading ? "加载中…" : "加载更多皮肤"}</button>}
      </div>
      {filters.skinIds.length > 1 && <div className="skin-match" role="radiogroup" aria-label="皮肤匹配方式">
        {(["ANY", "ALL"] as const).map((value) => <label key={value}><input type="radio" name="skin-match" checked={filters.match === value} onChange={() => navigate(withFilterChange(filters, { match: value }))} />{value === "ANY" ? "任一皮肤" : "全部皮肤"}</label>)}
      </div>}
    </div>
    </>;
  };

  return <ServiceShell surface="browse" contextLabel={null} breadcrumbs={breadcrumbs} title="租账号" description="先看资源配置与租用条件，费用和租期以服务端报价为准。" initialQuery={filters.q ?? ""} onSearch={(value) => navigate(withFilterChange(filters, { q: normalizeListingQuery(value) }))} searchLabel="在公开账号目录中搜索账号名称" searchInputLabel="搜索账号名称" searchPlaceholder="搜索账号名称">
    <section className="game-section market-section" aria-label="公开账号市场">
      {game && <div className="market-context" aria-label={`${game.name}游戏上下文`}>
        <div className="market-context-mark" aria-hidden="true">{game.code === "delta" ? "D" : "G"}</div>
        <div className="market-context-copy"><span>游戏专区</span><h2>{game.name}</h2><p>资源账号 · 按平台报价租用</p></div>
        {game.code === "delta" && <Link className="button delta-tool" href="/gunsmith"><Crosshair size={16} />改枪码</Link>}
      </div>}
      <div className="market-directory" id="account-list" tabIndex={-1}>
        <div className="market-directory-heading"><div><span className="market-kicker">公开租号</span><h2>可租账号</h2></div><span className="market-count" aria-live="polite">{feed.status === "ready" ? `本页 ${visible.length} 个账号` : feed.status === "error" ? "暂时无法读取" : "正在读取"}</span></div>
        <div className="market-filter-mobile-row">
          <span>{activeFilterSummary.length > 0 ? activeFilterSummary.join(" · ") : "按资源与展示皮肤筛选"}</span>
          <Drawer isOpen={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
            <Drawer.Trigger className="market-mobile-filter-trigger"><SlidersHorizontal size={16} aria-hidden="true" />筛选{filterCount > 0 ? ` · ${filterCount}` : ""}</Drawer.Trigger>
            <Drawer.Backdrop variant="opaque">
              <Drawer.Content placement="bottom">
                <Drawer.Dialog className="market-filter-drawer-dialog">
                  <Drawer.Handle />
                  <Drawer.CloseTrigger className="market-filter-drawer-close" aria-label="关闭筛选"><X size={18} aria-hidden="true" /></Drawer.CloseTrigger>
                  <Drawer.Header><Drawer.Heading>筛选账号</Drawer.Heading></Drawer.Header>
                  <Drawer.Body><form id={mobileFilterFormId} className="market-filters market-filters--drawer" aria-label="移动端账号筛选" onSubmit={applyMobileFilters}>{renderFilterFields("mobile")}</form></Drawer.Body>
                  <Drawer.Footer className="market-filter-drawer-footer"><Button fullWidth type={feed.status === "error" ? "button" : "submit"} form={feed.status === "error" ? undefined : mobileFilterFormId} variant="primary" isDisabled={feed.status === "loading" || pending} onPress={feed.status === "error" ? feed.reload : undefined}>{feed.status === "error" ? "重试账号目录" : feed.status === "loading" ? "正在读取…" : "应用筛选"}</Button></Drawer.Footer>
                </Drawer.Dialog>
              </Drawer.Content>
            </Drawer.Backdrop>
          </Drawer>
        </div>
        <form className="market-filters market-filters--desktop" aria-label="账号筛选" onSubmit={applyMinQty}>
            {renderFilterFields("desktop")}
            <div className="market-filter-actions">
              <span className="filter-count"><SlidersHorizontal size={14} aria-hidden="true" />{filterCount > 0 ? `已启用 ${filterCount} 项筛选` : "未启用筛选"}</span>
              {filterCount > 0 && <button type="button" className="button secondary" onClick={resetFilters}><X size={14} />清空筛选</button>}
            </div>
          </form>
          {filters.q && <div className="site-search-summary" role="status">
            <span>“{filters.q}” · {visible.length} 个匹配账号<small>服务端按公开账号名称筛选，结果仍可继续翻页。</small></span>
            <button type="button" onClick={() => navigate(withFilterChange(filters, { q: null }))}>清空搜索</button>
          </div>}
          <FavoriteNotice />
          <p className="market-trust-note" role="note">公开浏览无需登录 · 费用、押金和租期以服务端报价为准 · 下单后由真人客服协助履约</p>
          <div className="market-results-toolbar">
            <div><span className="market-kicker">结果目录</span><strong>{feed.status === "ready" ? `${visible.length} 个账号` : feed.status === "error" ? "读取失败" : "读取中"}</strong></div>
            <div className="market-results-controls">
              <span className="market-result-note">列表只展示比较所需信息</span>
              <div className="market-view-toggle" role="group" aria-label="账号展示方式">
                <button type="button" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>列表</button>
                <button type="button" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}>卡片</button>
              </div>
            </div>
          </div>
          <div className="market-results" aria-busy={busy}>
            {feed.status === "loading" ? <div className={`account-grid account-grid--${viewMode}`}>{Array.from({ length: 6 }, (_, index) => <AccountCardSkeleton key={index} />)}</div> :
              feed.status === "error" ? <AccountCardEmpty message="账号列表加载失败" description="请检查网络后重试。" onRetry={feed.reload} /> :
              visible.length > 0 ? <div className={`account-grid account-grid--${viewMode}`}>{visible.map((listing) => <AccountCard key={listing.id} data={toListingCard(listing)} />)}</div> :
              filterCount > 0 ? <AccountCardEmpty message="没有符合条件的账号" description="可以清空筛选条件，查看全部可租账号。" onReset={resetFilters} /> :
              <AccountCardEmpty message="暂无可选账号" description="当前没有可展示的号源，请稍后再来。" onRetry={feed.reload} />}
          </div>
          {(canPrev || canNext) && <nav className="market-pagination" aria-label="账号列表翻页">
            <button type="button" className="button secondary" disabled={!canPrev || busy} onClick={() => navigate({ ...filters, cursor: cursorTrail[trailIndex - 1] ?? null })}>上一页</button>
            <button type="button" className="button secondary" disabled={!canNext || busy} onClick={() => feed.nextCursor && navigate({ ...filters, cursor: feed.nextCursor })}>下一页</button>
          </nav>}
          {filters.cursor && <p className="market-cursor-note">当前为该筛选结果的后继批次；刷新或前进后退会回到这一批。</p>}
        </div>
    </section>
    <ActionFeedbackDialog {...notice} onClose={() => setNotice((value) => ({ ...value, isOpen: false }))} />
  </ServiceShell>;
}
