import type { Metadata } from "next";
import { PublishForm } from "@/components/service-pages";
import { publishMode } from "@/lib/service-navigation";
import { seoPageMetadata } from "@/lib/seo";

export const metadata: Metadata = seoPageMetadata({
  title: "出租三角洲账号",
  description: "把闲置的三角洲行动账号上架出租：填写资源与出租条件，通过审核后向租客展示，订单由平台真人客服履约。",
  path: "/publish",
});

export default async function Page({ searchParams }: { searchParams: Promise<{ mode?: string; game?: string; accountId?: string; edit?: string }> }) {
  const params = await searchParams;
  return <PublishForm mode={publishMode(params.mode)} gameCode={typeof params.game === "string" ? params.game : undefined} accountId={typeof params.accountId === "string" ? params.accountId : undefined} editRequested={params.edit === "1"} />;
}
