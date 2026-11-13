"use client";
import useEmblaCarousel from "embla-carousel-react";
import { ManagedMarketBanner, ManagedMarketContact } from "@/components/content/market-content";

export function DeltaBanner() {
  const [viewport] = useEmblaCarousel({ loop: false, watchDrag: false, watchFocus: false });
  return <div className="market-banner-layout">
    <div className="market-banner-carousel" role="region" aria-roledescription="轮播" aria-label="三角洲行动专区宣传">
      <div className="market-banner-viewport" ref={viewport}>
        <div className="market-banner-track">
          <div className="market-banner-slide" role="group" aria-roledescription="幻灯片" aria-label="三角洲行动资源账号租赁">
            <ManagedMarketBanner />
          </div>
        </div>
      </div>
    </div>
    <div className="market-contact-templates" aria-label="联系二维码">
      <ManagedMarketContact channel="MARKET_PLAYER_GROUP" />
      <ManagedMarketContact channel="MARKET_COOPERATION" />
    </div>
  </div>;
}
