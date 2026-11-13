"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { EntitlementKind, GrowthTier } from "../../lib/membership-growth-client";
import { ENTITLEMENT_BADGE_IMAGE, GROWTH_TIER_EN_LABELS, GROWTH_TIER_LABELS, TIER_CARD_IMAGE, TIER_CARD_SQUARE, type TrackTier } from "./membership-center-format";

export function GrowthMemberCardArt({ tier }: { tier: GrowthTier | null }) {
  const safeTier = tier ?? "UNKNOWN";
  const enLabel = GROWTH_TIER_EN_LABELS[safeTier] ?? "MEMBER CARD";
  const zhLabel = safeTier === "BLACK_GOLD" ? "黑金会员 · 终身" : (tier ? (GROWTH_TIER_LABELS[tier] ?? "会员身份") : "会员身份");
  const cardImageSrc = tier ? TIER_CARD_IMAGE[tier] : null;
  const [imageFailed, setImageFailed] = useState(false);
  const [currentTier, setCurrentTier] = useState(tier);

  if (currentTier !== tier) {
    setCurrentTier(tier);
    setImageFailed(false);
  }

  const showImage = Boolean(cardImageSrc && !imageFailed);

  return (
    <div
      className={`membership-card card-tier-${safeTier.toLowerCase().replace("_", "-")}${showImage ? " has-card-art" : ""}`}
      data-testid="membership-card"
      data-tier={tier ?? undefined}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          key={cardImageSrc!}
          src={cardImageSrc!}
          alt=""
          aria-hidden="true"
          className="membership-card-img"
          width={1020}
          height={600}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="membership-card-fallback-content">
          <div className="membership-card-top">
            <span className="membership-card-brand">洲洲商行</span>
            <span className="membership-card-slogan">以行致远 · 汇聚美好</span>
          </div>
          <div className="membership-card-mid">
            <span className="membership-card-en">{enLabel}</span>
          </div>
          <div className="membership-card-bot">
            {safeTier === "BLACK_GOLD" ? <span className="membership-card-infinity">∞</span> : null}
            <span className="membership-card-level">{zhLabel}</span>
          </div>
          <div className="membership-card-emboss" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export function EntitlementBadge({ kind, label, size = 32 }: { kind: EntitlementKind; label: string; size?: number }) {
  const badgeSrc = ENTITLEMENT_BADGE_IMAGE[kind];
  const [imageFailed, setImageFailed] = useState(false);
  const [prevSrc, setPrevSrc] = useState(badgeSrc);
  if (prevSrc !== badgeSrc) {
    setPrevSrc(badgeSrc);
    setImageFailed(false);
  }
  const showImage = Boolean(badgeSrc && !imageFailed);
  return (
    <span className="account-entitlement-badge-wrap" aria-hidden="true">
      {showImage ? (
        <img
          key={badgeSrc!}
          src={badgeSrc!}
          alt={label}
          aria-hidden="true"
          className="account-entitlement-badge-img"
          width={size}
          height={size}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="account-entitlement-badge-icon" aria-hidden="true">
          <Sparkles size={Math.round(size / 2)} />
        </span>
      )}
    </span>
  );
}

export function TierCardImage({ tier, square }: { tier: TrackTier; square: boolean }) {
  const src = square ? TIER_CARD_SQUARE[tier] : TIER_CARD_IMAGE[tier];
  const [failed, setFailed] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setFailed(false);
  }
  if (failed || !src) return <GrowthMemberCardArt tier={tier} />;
  return (
    <img
      key={src}
      className="mc-card-img"
      src={src}
      alt=""
      width={square ? 768 : 1020}
      height={square ? 768 : 600}
      onError={() => setFailed(true)}
    />
  );
}
