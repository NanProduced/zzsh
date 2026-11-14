import type { Metadata } from "next";
import { AccountMarket } from "@/components/market/account-market";
import { DELTA_GAME_CODE } from "@/lib/supply-games";
import { seoPageMetadata } from "@/lib/seo";

const DESCRIPTION = "浏览洲洲商行在租的三角洲行动账号，按段位、哈夫币、皮肤等条件筛选，查看资源费用、押金与租期。";

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const params = await searchParams;
  const keys = Object.keys(params).filter((key) => params[key] !== undefined);
  const unfiltered = keys.length === 0 || (keys.length === 1 && keys[0] === "game" && params.game === DELTA_GAME_CODE);
  return seoPageMetadata({
    title: "三角洲行动租号大厅",
    description: DESCRIPTION,
    path: "/accounts",
    robots: unfiltered ? undefined : "noindex, follow",
  });
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <AccountMarket searchParams={await searchParams} />;
}