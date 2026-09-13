import { ListingDetail } from "@/components/market/listing-detail";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingDetail accountId={id} />;
}
