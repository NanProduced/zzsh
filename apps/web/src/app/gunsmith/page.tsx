import { GunsmithPage } from "@/components/gunsmith/gunsmith-page";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : Array.isArray(params.q) ? params.q[0] ?? "" : "";
  return <GunsmithPage initialQuery={query} />;
}
