"use client";

import { Box } from "lucide-react";
import { orderedQuoteResources } from "@/components/delta/account-card";
import { CatalogItemArt } from "@/components/supply/catalog-item-art";
import { formatSupplyItem } from "@/lib/account-title";
import type { ListingDetailData } from "@/lib/listing-view";
import { DetailImage } from "./listing-detail-gallery";

export function ListingDetailInventory({ data }: { data: ListingDetailData }) {
  const resources = orderedQuoteResources(data);
  return (
    <section className="account-stock" aria-labelledby="account-stock-title">
      <div className="account-section-title">
        <h2 id="account-stock-title">
          <Box size={20} aria-hidden="true" />物资库存
        </h2>
        <span>号主申报数量</span>
      </div>
      {resources.length ? (
        <div className="account-stock-grid account-resource-quantities">
          {resources.map((line) => {
            const itemInfo = formatSupplyItem(line);
            return (
              <div
                key={line.itemId}
                className="account-stock-card"
                data-resource-id={line.itemId}
                data-zero={itemInfo.isZero || undefined}
              >
                <div className="account-stock-card-art">
                  <CatalogItemArt mediaId={line.mediaId}>{itemInfo.imageSrc ? (
                    <DetailImage src={itemInfo.imageSrc} alt="" className="account-stock-card-img" />
                  ) : (
                    <Box size={24} aria-hidden="true" />
                  )}</CatalogItemArt>
                </div>
                <div className="account-stock-card-info">
                  <dt className="account-stock-card-name" title={line.name}>{line.name}</dt>
                  <dd className={`account-stock-card-qty${itemInfo.isUnknown ? " account-value-unknown" : ""}`}>
                    {itemInfo.quantityText}
                  </dd>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="account-empty-note">尚未申报可展示的物资库存。</p>
      )}
      <p className="account-stock-note">
        {data.historicalReadOnly
          ? "以上为来源库存记录，当前不可据此下单。"
          : "物资金额先预付，最终按实际消耗与有效规则结算。"}
      </p>
    </section>
  );
}
