import { PublishForm } from "@/components/service-pages";
import { publishMode } from "@/lib/service-navigation";
export default async function Page({ searchParams }: { searchParams: Promise<{ mode?: string; game?: string; accountId?: string; edit?: string }> }) {
  const params = await searchParams;
  return <PublishForm mode={publishMode(params.mode)} gameCode={typeof params.game === "string" ? params.game : undefined} accountId={typeof params.accountId === "string" ? params.accountId : undefined} editRequested={params.edit === "1"} />;
}
