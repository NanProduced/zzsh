import { ListingDetail } from "@/components/market/listing-detail";
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fromOrder?: string; party?: string }> }) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  return <ListingDetail accountId={id} fromOrder={typeof search.fromOrder === "string" ? search.fromOrder : undefined} fromParty={search.party === "owner" ? "owner" : "renter"} />;
}
