"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { supplyApi } from "@/lib/supply-client";
import { toListingCard } from "@/lib/listing-view";
import { AccountCard, type AccountCardData } from "@/components/delta/account-card";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";

export function RecommendedAccountsSection({
  currentAccountId,
  gameId,
  gameName,
}: {
  currentAccountId: string;
  gameId?: string | null;
  gameName?: string | null;
}) {
  const [items, setItems] = useState<AccountCardData[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  useEffect(() => {
    if (!gameId) {
      setStatus("empty");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");

    const query = new URLSearchParams();
    query.set("queryVersion", "2");
    query.set("gameId", gameId);
    query.set("limit", "8");

    supplyApi
      .market(query, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        const valid = page.items
          .filter((item) => item.id !== currentAccountId)
          .slice(0, 4)
          .map(toListingCard);
        if (valid.length > 0) {
          setItems(valid);
          setStatus("ready");
        } else {
          setStatus("empty");
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus("error");
      });

    return () => controller.abort();
  }, [currentAccountId, gameId]);

  if (status === "empty" || status === "error") {
    return null;
  }

  return (
    <section className="detail-recommended-section" aria-label="同款游戏推荐号源">
      <div className="detail-recommended-header">
        <div className="detail-recommended-title-wrap">
          <Sparkles size={18} className="detail-recommended-icon" aria-hidden="true" />
          <h2 className="detail-recommended-title">更多{gameName || "同款游戏"}账号</h2>
        </div>
        <Link
          href={`/accounts?game=${encodeURIComponent(gameId ?? "")}`}
          className="detail-recommended-more-btn"
        >
          <span>查看全部账号</span>
          <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>

      <div className="detail-recommended-grid">
        {status === "loading"
          ? Array.from({ length: 4 }, (_, idx) => (
              <AccountCardSkeleton key={idx} viewMode="grid" />
            ))
          : items.map((account) => (
              <AccountCard key={account.id} data={account} viewMode="grid" />
            ))}
      </div>
    </section>
  );
}
