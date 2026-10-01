"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HeartOff, RotateCw } from "lucide-react";
import { AccountCard } from "@/components/delta/account-card";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";
import { FavoriteButton, FavoriteNotice } from "./favorite-button";
import { useFavorites } from "./favorites-context";
import { toListingCard } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import type { Favorite } from "@/lib/supply-types";

type PanelState = { generation: number; status: "idle" | "loading" | "ready" | "error"; items: Favorite[]; nextCursor: string | null; moreError: boolean };
export function FavoritesPanel() {
  const favorites = useFavorites();
  const snapshot = favorites?.snapshot;
  const identity = snapshot?.status ?? "loading";
  const userId = snapshot?.userId ?? null;
  const generation = snapshot?.generation ?? 0;
  const [state, setState] = useState<PanelState>({ generation, status: "idle", items: [], nextCursor: null, moreError: false });
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  const load = useCallback(async (cursor: string | null, append: boolean, requestedGeneration: number) => {
    if (!append) setState({ generation: requestedGeneration, status: "loading", items: [], nextCursor: null, moreError: false });
    else setState((prev) => ({ ...prev, status: "loading", moreError: false }));
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const page = await supplyApi.favorites(query);
      if (requestedGeneration !== generationRef.current) return;
      // Server records are the saved evidence for these accounts; local operations override them.
      favoritesRef.current?.registerSavedRecords(page.items.map((item) => item.accountId));
      setState((prev) => {
        if (!append) return { generation: requestedGeneration, status: "ready", items: page.items, nextCursor: page.nextCursor, moreError: false };
        const existing = new Set(prev.items.map((item) => item.accountId));
        return { generation: requestedGeneration, status: "ready", items: [...prev.items, ...page.items.filter((item) => !existing.has(item.accountId))], nextCursor: page.nextCursor, moreError: false };
      });
    } catch (error) {
      if (requestedGeneration !== generationRef.current) return;
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
  }, [identity, userId, generation, attempt, load]);

  if (identity === "loading") return <section className="account-guest" aria-busy="true"><h2>正在读取登录状态…</h2><p>请稍候，个人收藏准备中。</p></section>;
  if (identity === "guest")
    return <section className="account-guest">
      <HeartOff size={30} />
      <h2>登录后查看我的收藏</h2>
      <p>收藏保存在服务端账号中，登录后回到本页继续管理。</p>
      <Link href="/login?next=%2Faccount%3Fview%3Dfavorites" className="button primary">登录 / 注册</Link>
    </section>;
  if (identity === "error")
    return <section className="account-guest">
      <h2>暂时无法确认登录状态</h2>
      <p>请检查网络后重试；期间不会展示任何个人收藏数据。</p>
      <button type="button" className="button secondary" onClick={() => favorites?.reload()}><RotateCw size={15} />重试</button>
    </section>;

  const panel = state.generation === generation ? state : { generation, status: "loading" as const, items: [], nextCursor: null, moreError: false };
  const visible = panel.items.filter((item) => favorites?.statusOf(item.accountId) !== "unsaved");
  return <section className="favorites-panel account-module" aria-busy={panel.status === "loading"}>
    <header className="account-module-heading"><div><h2>我的收藏</h2><p>保存感兴趣的账号，随时回来查看最新资料。</p></div></header>
    <FavoriteNotice />
    {panel.status === "loading" && panel.items.length === 0 ? <div className="account-grid">{Array.from({ length: 3 }, (_, index) => <AccountCardSkeleton key={index} />)}</div> :
      panel.status === "error" ? <div className="account-module-card account-empty-state" role="alert"><HeartOff size={28} aria-hidden="true" /><h3>收藏列表暂时无法读取</h3><p>请检查网络后重试。</p><button type="button" className="button secondary" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={15} />重试</button></div> :
      visible.length === 0 ? <div className="account-module-card account-empty-state" role="status"><HeartOff size={28} aria-hidden="true" /><h3>还没有收藏的账号</h3><p>在账号列表或详情页点击心形按钮即可收藏。</p><Link href="/accounts" className="button secondary">浏览账号</Link></div> :
      <div className="account-grid">
        {visible.map((item) => item.listing ? <AccountCard key={item.accountId} data={toListingCard(item.listing)} /> :
          <article key={item.accountId} className="account-card favorite-unavailable">
            <div className="account-unavailable-body">
              <HeartOff size={26} aria-hidden="true" />
              <h3>该账号暂不可用</h3>
              <p>{item.message ?? "该供给暂不可用，收藏已保留"}</p>
              <FavoriteButton accountId={item.accountId} title="该账号" variant="inline" />
            </div>
          </article>)}
      </div>}
    {panel.moreError ? <div className="favorites-more-error" role="alert"><span>更多收藏暂未加载，已显示的账号仍保留。</span><button type="button" className="button secondary" onClick={() => void load(panel.nextCursor, true, generationRef.current)}>重试加载</button></div> : null}
    {panel.nextCursor && !panel.moreError ? <div className="market-pagination"><button type="button" className="button secondary" disabled={panel.status === "loading"} onClick={() => void load(panel.nextCursor, true, generationRef.current)}>{panel.status === "loading" ? "正在读取…" : "加载更多收藏"}</button></div> : null}
  </section>;
}
