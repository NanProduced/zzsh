import type { Metadata } from "next";
import { ListingDetail } from "@/components/market/listing-detail";
import { seoPageMetadata } from "@/lib/seo";

export async function generateMetadata({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fromOrder?: string; party?: string }> }): Promise<Metadata> {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const personalized = typeof search.fromOrder === "string" || search.party !== undefined;
  return seoPageMetadata({
    title: "账号详情",
    description: "查看三角洲行动账号的资源、费用、押金与租赁条件。",
    path: `/accounts/${id}`,
    robots: personalized ? "noindex, follow" : undefined,
  });
}

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fromOrder?: string; party?: string }> }) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  return <ListingDetail accountId={id} fromOrder={typeof search.fromOrder === "string" ? search.fromOrder : undefined} fromParty={search.party === "owner" ? "owner" : "renter"} />;
}
