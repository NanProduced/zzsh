"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, ImageOff } from "lucide-react";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { rememberAccountReturn } from "@/lib/account-return";
import { listingResourceLinesLabel, type ListingCardData } from "@/lib/listing-view";

// Card view model derived from the server PublicListing; the client never recomputes price or term.
export type AccountCardData = ListingCardData;
export function accountHref(accountId: string): string {
  return "/accounts/" + encodeURIComponent(accountId);
}
export function AccountCard({ data }: { data: AccountCardData }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const missing = !data.imageUrl || failedSrc === data.imageUrl;
  const conditions = data.conditionLines.slice(0, 3);
  const moreConditions = data.conditionLines.length - conditions.length;
  return <article className="account-card" aria-label={data.title}>
    <div className="account-image">
      {missing ? <span className="image-fallback"><ImageOff size={22} />{data.imageUrl ? "图片加载失败" : "图片未提供"}</span> :
        <img src={data.imageUrl} alt={`${data.title}公开图片`} onError={() => setFailedSrc(data.imageUrl)} loading="lazy" />}
      <FavoriteButton accountId={data.id} title={data.title} />
    </div>
    <div className="account-content">
      <h3><Link href={accountHref(data.id)} onClick={() => rememberAccountReturn(window.location)}>{data.title}</Link></h3>
      <p className="account-resources">{listingResourceLinesLabel(data) || "资源以账号详情为准"}</p>
      {(conditions.length > 0) && <p className="account-conditions">
        {conditions.map((line) => `${line.label} ${line.value}`).join(" · ")}
        {moreConditions > 0 ? ` · 等${data.conditionLines.length}项` : ""}
      </p>}
      <dl className="account-fees">
        <div><dt>资源费用</dt><dd>{data.resourceTotalLabel}</dd></div>
        <div><dt>押金</dt><dd>{data.depositLabel ?? "待确认"}</dd></div>
      </dl>
      <dl className="account-terms">
        <div><dt>预计租期</dt><dd>{data.termLabel}</dd></div>
        {data.skinNames.length > 0 && <div><dt>展示皮肤</dt><dd>{data.skinNames.join("、")}</dd></div>}
      </dl>
      <Link className="button account-detail" href={accountHref(data.id)} onClick={() => rememberAccountReturn(window.location)}>查看账号<ArrowUpRight size={15} /></Link>
    </div>
  </article>;
}
