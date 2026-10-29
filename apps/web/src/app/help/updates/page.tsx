import { redirect } from 'next/navigation';
export default async function LegacyUpdates({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  redirect(query.type === 'ANNOUNCEMENT' || query.type === 'NEWS' ? `/updates?type=${query.type}` : '/updates');
}
