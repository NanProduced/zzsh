"use client";

import { Shirt } from "lucide-react";
import { SkinMediaPreview, SkinMetadata, skinCardTitle } from "@/components/supply/skin-media-thumb";
import { skinTypeLabel, type ListingDetailData } from "@/lib/listing-view";
import { entitlementExpiryLabel, withheldSkinsNote } from "./listing-detail-format";

export function ListingDetailSkins({ data }: { data: ListingDetailData }) {
  const skinGroups = new Map<string, ListingDetailData["skinTags"]>();
  for (const tag of data.skinTags) {
    const category = skinTypeLabel(tag.ownerKind) ?? "类型待核";
    skinGroups.set(category, [...(skinGroups.get(category) ?? []), tag]);
  }

  return (
    <section className="account-cosmetics-section" aria-labelledby="account-skins-title">
      <div className="account-section-title">
        <h2 id="account-skins-title">
          <Shirt size={20} aria-hidden="true" />皮肤与权益
        </h2>
      </div>
      {withheldSkinsNote(data.skinsWithheld) ? (
        <p className="account-note-source">{withheldSkinsNote(data.skinsWithheld)}</p>
      ) : null}
      {data.skinTags.length || data.entitlementNames.length ? (
        <div className="account-cosmetics-body">
          <div className="account-skin-groups">
            {[...skinGroups].map(([category, skins]) => (
              <section key={category} className="account-skin-group">
                <div className="account-skin-group-head">
                  <strong>{category}</strong>
                  <span>{skins.length}项</span>
                </div>
                <div className="account-skin-grid">
                  {skins.map((tag, i) => (
                    <article
                      key={`${tag.id}:${i}`}
                      className="account-skin-card"
                      data-skin-id={tag.id}
                      data-owner-kind={tag.ownerKind ?? "UNKNOWN"}
                    >
                      <div className="account-skin-card-media-wrap">
                        <SkinMediaPreview
                          skin={tag}
                          triggerClassName="skin-media-preview-trigger account-skin-card-media-btn"
                          mediaClassName="account-skin-card-media"
                          fallbackClassName="account-skin-card-media-fallback"
                        />
                        <SkinMetadata skin={tag} qualityTag className="account-skin-card-quality" />
                      </div>
                      <strong className="account-skin-card-name" title={skinCardTitle(tag)}>{skinCardTitle(tag)}</strong>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <div className="account-entitlement-list">
            {data.entitlementDetails?.length
              ? data.entitlementDetails.map((item) => (
                  <div key={item.id} className="account-entitlement-item">
                    <strong>{item.name}</strong>
                    <span>{entitlementExpiryLabel(item)}</span>
                  </div>
                ))
              : data.entitlementNames.map((name, index) => (
                  <div key={`${name}:${index}`} className="account-entitlement-item">
                    <strong>{name}</strong>
                    <span>权益详情以个人确认时为准</span>
                  </div>
                ))}
          </div>
        </div>
      ) : (
        <p className="account-empty-note">暂无皮肤或权益的公开申报。</p>
      )}
    </section>
  );
}
