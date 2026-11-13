"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { ServiceShell } from "@/components/layout/service-shell";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { BusinessUpdateNotices } from "@/components/content/platform-update-notices";
import { accountReturnTarget, readAccountReturn } from "@/lib/account-return";
import { detailBreadcrumbs, toListingDetail, type ListingDetailData } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import { RecommendedAccountsSection } from "./recommended-accounts";
import { ListingDetailConfirm } from "./listing-detail-confirm";
import { ListingDetailFacts, ListingDetailHeading } from "./listing-detail-profile";
import { ListingDetailInventory } from "./listing-detail-inventory";
import { ListingDetailSkins } from "./listing-detail-skins";
import "./account-detail.css";

export { deriveDetailTitle, formatSupplyItem, parseRank, parseSafeBox } from "@/lib/account-title";
export { DetailGallery } from "./listing-detail-gallery";
export { entitlementExpiryLabel, formatItemUnitPrice, inventoryQuantityText, unitPriceText, withheldSkinsNote } from "./listing-detail-format";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; data: ListingDetailData; gameCode?: string }
  | { status: "unavailable" }
  | { status: "error" };
type BackTarget = { href: string; label: string };

export function ListingDetail({ accountId, fromOrder, fromParty = "renter" }: { accountId: string; fromOrder?: string; fromParty?: "renter" | "owner" }) {
  return (
    <FavoritesProvider>
      <DetailView accountId={accountId} fromOrder={fromOrder} fromParty={fromParty} />
    </FavoritesProvider>
  );
}

function ReadyDetail({ data, fromOrder, fromParty = "renter" }: { data: ListingDetailData; fromOrder?: string; fromParty?: "renter" | "owner" }) {
  return (
    <article className="listing-detail account-detail">
      <BusinessUpdateNotices surface="rental" gameId={data.gameId} />
      <ListingDetailHeading data={data} fromOrder={fromOrder} />
      <div className="account-detail-layout">
        <div className="account-detail-left">
          <ListingDetailFacts data={data} />
          <ListingDetailInventory data={data} />
          <ListingDetailSkins data={data} />
        </div>
        <ListingDetailConfirm data={data} fromOrder={fromOrder} fromParty={fromParty} />
      </div>
      <RecommendedAccountsSection
        currentAccountId={data.id}
        gameId={data.gameId}
        gameName={data.gameName}
      />
    </article>
  );
}

function DetailView({ accountId, fromOrder, fromParty = "renter" }: { accountId: string; fromOrder?: string; fromParty?: "renter" | "owner" }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [back, setBack] = useState<BackTarget>({ href: "/accounts", label: "返回账号列表" });

  useEffect(() => {
    setBack(accountReturnTarget(readAccountReturn(accountId)));
  }, [accountId]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    supplyApi
      .listing(accountId, controller.signal)
      .then((listing) => {
        if (!controller.signal.aborted) {
          if (listing.id !== accountId) throw new Error("Listing object mismatch");
          setState({ status: "ready", data: toListingDetail(listing), gameCode: listing.game?.code });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable = error instanceof SupplyRequestError && [401, 403, 404].includes(error.status);
        setState({ status: unavailable ? "unavailable" : "error" });
      });
    return () => controller.abort();
  }, [accountId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const current = state.status === "ready" && state.data.id !== accountId ? { status: "loading" as const } : state;
  const title = "账号详情";
  const description = "";
  const breadcrumbs = detailBreadcrumbs(state.status === "ready" ? state.data.gameName : null);

  return (
    <ServiceShell
      surface="detail"
      contextLabel={null}
      breadcrumbs={breadcrumbs}
      title={title}
      description={description}
      backHref={back.href}
      backLabel={back.label}
      showPageHeading={false}
      headingInContent={current.status === "ready"}
      searchLabel="在公开目录中搜索账号编号或关键词"
      searchInputLabel="搜索账号编号或关键词"
      searchPlaceholder="搜索其他账号编号或关键词"
    >
      {current.status === "loading" ? (
        <div className="detail-skeleton" aria-busy="true" aria-label="正在加载账号详情">
          <div className="detail-skeleton-hero" aria-hidden="true">
            <div className="detail-skeleton-gallery" />
            <div className="detail-skeleton-copy">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="detail-skeleton-blocks" aria-hidden="true">
            <div />
            <div />
          </div>
        </div>
      ) : current.status === "unavailable" ? (
        <section className="account-empty listing-unavailable" role="status">
          <h3>该账号暂不可用或已下架</h3>
          <p>该账号当前没有可公开的租用信息，请返回列表选择其他账号。</p>
          <Link className="button secondary" href={back.href}>
            {back.label}
          </Link>
        </section>
      ) : current.status === "error" ? (
        <section className="account-empty" role="alert">
          <h3>账号详情加载失败</h3>
          <p>请检查网络后重试。</p>
          <button type="button" className="button secondary" onClick={retry}>
            <RotateCw size={15} />重试
          </button>
        </section>
      ) : (
        <>{current.status === "ready" ? <ReadyDetail data={current.data} fromOrder={fromOrder} fromParty={fromParty} /> : null}</>
      )}
    </ServiceShell>
  );
}
