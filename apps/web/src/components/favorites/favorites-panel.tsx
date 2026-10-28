"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HeartOff, RotateCw, TriangleAlert } from "lucide-react";
import { AccountCard } from "@/components/delta/account-card";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";
import { FavoriteButton, FavoriteNotice } from "./favorite-button";
import { useFavorites } from "./favorites-context";
import { previewListingCard } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import type { Favorite } from "@/lib/supply-types";
import "./favorites-panel.css";

/** 收藏时间一律北京时间展示，不使用设备本地时区。 */
function savedTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "收藏时间暂未提供";
  return `收藏于 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)).replaceAll("/", "-")}`;
}

/** 已加载记录的本地筛选口径：可查看＝有可读公开摘要；暂不可用＝服务端业务态；摘要故障卡只在“全部”出现。 */
type FavoriteFilter = "all" | "readable" | "unavailable";

function isSummaryReadable(item: Favorite): boolean {
  return Boolean(item.listing) && previewListingCard(item.listing!).ok;
}

type PanelState = { generation: number; status: "idle" | "loading" | "ready" | "error"; items: Favorite[]; nextCursor: string | null; moreError: boolean };
export function FavoritesPanel() {
  const favorites = useFavorites();
  const snapshot = favorites?.snapshot;
  const identity = snapshot?.status ?? "loading";
  const userId = snapshot?.userId ?? null;
  const generation = snapshot?.generation ?? 0;
  const [state, setState] = useState<PanelState>({ generation, status: "idle", items: [], nextCursor: null, moreError: false });
  const [attempt, setAttempt] = useState(0);
  // 本地筛选（状态/搜索）只作用于已加载记录，工具条固定标注范围，不伪装全量。
  const [filter, setFilter] = useState<FavoriteFilter>("all");
  const [search, setSearch] = useState("");
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const readSequenceRef = useRef(0);
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  const load = useCallback(async (cursor: string | null, append: boolean, requestedGeneration: number) => {
    const sequence = ++readSequenceRef.current;
    const isCurrent = () => requestedGeneration === generationRef.current && sequence === readSequenceRef.current;
    if (!append) setState({ generation: requestedGeneration, status: "loading", items: [], nextCursor: null, moreError: false });
    else setState((prev) => ({ ...prev, status: "loading", moreError: false }));
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const page = await supplyApi.favorites(query);
      if (!isCurrent()) return;
      // Server records are the saved evidence for these accounts; local operations override them.
      favoritesRef.current?.registerSavedRecords(page.items.map((item) => item.accountId));
      setState((prev) => {
        if (!append) return { generation: requestedGeneration, status: "ready", items: page.items, nextCursor: page.nextCursor, moreError: false };
        const existing = new Set(prev.items.map((item) => item.accountId));
        return { generation: requestedGeneration, status: "ready", items: [...prev.items, ...page.items.filter((item) => !existing.has(item.accountId))], nextCursor: page.nextCursor, moreError: false };
      });
    } catch (error) {
      if (!isCurrent()) return;
      const retryable = !(error instanceof SupplyRequestError) || error.status === 0 || error.status === 429 || error.status >= 500;
      if (append && retryable) setState((prev) => ({ ...prev, status: "ready", moreError: true }));
      else setState({ generation: requestedGeneration, status: "error", items: [], nextCursor: null, moreError: false });
      if (error instanceof SupplyRequestError && error.status === 401) favoritesRef.current?.reload();
    }
  }, []);

  useEffect(() => {
    if (identity !== "authenticated" || !userId) {
      setState({ generation, status: "idle", items: [], nextCursor: null, moreError: false });
      return;
    }
    void load(null, false, generation);
    return () => { readSequenceRef.current += 1; };
  }, [identity, userId, generation, attempt, load]);

  if (identity === "loading") return <section aria-busy="true" aria-label="正在加载收藏"><p className="session-loading-label" role="status">正在加载收藏…</p><div className="account-grid" aria-hidden="true">{Array.from({ length: 3 }, (_, index) => <AccountCardSkeleton key={index} />)}</div></section>;
  if (identity === "guest")
    return <section className="account-guest">
      <HeartOff size={30} />
      <h2>登录后查看我的收藏</h2>
      <p>收藏保存在服务端账号中，登录后回到本页继续管理。</p>
      <Link href="/login?next=%2Faccount%3Fview%3Dfavorites" className="button primary">登录 / 注册</Link>
    </section>;
  if (identity === "error")
    return <section className="account-guest" role="alert">
      <h2>登录状态暂未确认</h2>
      <p>暂时没能确认这次的登录状态（网络或服务短暂不可用）。期间不会展示任何个人收藏数据；还没登录的话，直接去登录。</p>
      <div className="account-guest-actions">
        <button type="button" className="button secondary" onClick={() => favorites?.reload()}><RotateCw size={15} />重新确认</button>
        <Link className="button primary" href="/login?next=%2Faccount%3Fview%3Dfavorites">去登录</Link>
      </div>
    </section>;

  const panel = state.generation === generation ? state : { generation, status: "loading" as const, items: [], nextCursor: null, moreError: false };
  const visible = panel.items.filter((item) => favorites?.statusOf(item.accountId) !== "unsaved");
  // 摘要故障卡与业务不可用卡分开计数：两者不得合并为同一状态。
  const faultCount = visible.filter((item) => item.state === "AVAILABLE" && !isSummaryReadable(item)).length;
  const matchesFilter = (item: Favorite) =>
    filter === "all" ? true
      : filter === "unavailable" ? item.state === "UNAVAILABLE"
      : item.state === "AVAILABLE" && isSummaryReadable(item);
  const matchesSearch = (item: Favorite) => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return true;
    const preview = item.listing ? previewListingCard(item.listing) : null;
    const title = preview?.ok ? preview.card.title : (item.listing?.title ?? "");
    const displayNo = preview?.ok ? preview.card.displayNo ?? "" : item.listing?.displayNo ?? "";
    return `${title} ${displayNo}`.toLowerCase().includes(keyword);
  };
  const shown = visible.filter((item) => matchesFilter(item) && matchesSearch(item));
  const empty = visible.length === 0;
  return <section className="favorites-panel account-module" aria-busy={panel.status === "loading"}>
    <header className="account-module-heading"><div><h2>我的收藏</h2><p>保存感兴趣的账号，随时回来查看最新资料。收藏不代表账号仍可租，价格与租赁条件以详情实时读取为准。</p></div></header>
    <FavoriteNotice />
    {empty ? null : <div className="favorites-toolbar">
      <span className="favorites-count">已加载 {visible.length} 个</span>
      <div className="favorites-chips" role="group" aria-label="按可查看性筛选已加载记录">
        {([['all', '全部'], ['readable', '可查看'], ['unavailable', '暂不可用']] as const).map(([value, label]) => (
          <button key={value} type="button" className="favorites-chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      <label className="favorites-search"><span className="favorites-search-label">搜索已加载账号</span>
        <input type="search" value={search} placeholder="标题 / 编号" onChange={(event) => setSearch(event.target.value)} />
      </label>
      <span className="favorites-scope-hint">仅筛选已加载的 {visible.length} 个</span>
    </div>}
    {panel.status === "loading" && panel.items.length === 0 ? <div className="account-grid">{Array.from({ length: 3 }, (_, index) => <AccountCardSkeleton key={index} />)}</div> :
      panel.status === "error" ? <div className="account-module-card account-empty-state" role="alert"><HeartOff size={28} aria-hidden="true" /><h3>收藏列表暂时无法读取</h3><p>读取失败不等于没有收藏；请重试。</p><button type="button" className="button secondary" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={15} />重试</button></div> :
      empty ? <div className="account-module-card account-empty-art-state" role="status">
        <img className="account-empty-art" src="/art/empty/favorites-r1.webp" alt="" width={240} height={180} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
        <h3>还没有收藏的账号</h3>
        <p>浏览账号时点一下收藏，之后就能在这里随时回来查看最新资料。</p>
        <div className="account-empty-actions"><Link href="/accounts" className="button primary">浏览账号</Link></div>
      </div> :
      shown.length === 0 ? <div className="account-module-card account-empty-state" role="status">
        <h3>当前筛选没有匹配的收藏</h3>
        <p>筛选只作用于已加载的 {visible.length} 个收藏。</p>
        <button type="button" className="button secondary" onClick={() => { setFilter("all"); setSearch(""); }}>清除筛选</button>
      </div> :
      <div className="account-grid favorites-grid">
        {shown.map((item) => {
          const preview = item.listing ? previewListingCard(item.listing) : { ok: false as const };
          // F3：单条摘要异常降级为故障卡，不击穿整页，也不与业务不可用合并。
          if (item.state === "AVAILABLE" && !preview.ok) return <article key={item.accountId} className="account-card favorite-summary-fault" data-state="unreadable">
            <div className="account-unavailable-body">
              <TriangleAlert size={26} aria-hidden="true" />
              <h3>摘要暂不可读取</h3>
              <p>收藏记录仍在，重新读取后即可恢复展示。</p>
              <p className="favorite-saved-at">{savedTime(item.savedAt)}</p>
              <FavoriteButton accountId={item.accountId} title="该账号" variant="inline" />
            </div>
          </article>;
          if (item.state === "UNAVAILABLE" || !preview.ok || !item.listing) return <article key={item.accountId} className="account-card favorite-unavailable" data-state="unavailable">
            <div className="account-unavailable-body">
              <HeartOff size={26} aria-hidden="true" />
              <h3>该账号暂不可用</h3>
              <p>{item.message ?? "该账号暂不可用，收藏已保留"}</p>
              <p className="favorite-saved-at">{savedTime(item.savedAt)}</p>
              <FavoriteButton accountId={item.accountId} title="该账号" variant="inline" />
            </div>
          </article>;
          return <div key={item.accountId} className="favorite-entry">
            <AccountCard data={preview.card} coverRetry />
            <p className="favorite-saved-at">{savedTime(item.savedAt)}</p>
          </div>;
        })}
      </div>}
    {faultCount > 0 ? <div className="favorites-fault-notice" role="status">
      <p>有 {faultCount} 个收藏的账号摘要暂时无法读取；收藏记录仍在，可重新读取。</p>
      <button type="button" className="button secondary button--sm" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={15} />重新读取</button>
    </div> : null}
    {panel.moreError ? <div className="favorites-more-error" role="alert"><span>更多收藏暂未加载，已显示的账号仍保留。</span><button type="button" className="button secondary" onClick={() => void load(panel.nextCursor, true, generationRef.current)}>重试加载</button></div> : null}
    {panel.nextCursor && !panel.moreError ? <div className="market-pagination"><button type="button" className="button secondary" disabled={panel.status === "loading"} onClick={() => void load(panel.nextCursor, true, generationRef.current)}>{panel.status === "loading" ? "正在读取…" : "加载更多收藏"}</button></div> : null}
  </section>;
}
