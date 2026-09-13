import { AccountMarket } from "@/components/market/account-market";
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <AccountMarket searchParams={await searchParams} />;
}
