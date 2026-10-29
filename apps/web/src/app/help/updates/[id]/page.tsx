import { permanentRedirect } from 'next/navigation';
export default async function LegacyUpdate({ params }: { params: Promise<{ id: string }> }) { permanentRedirect(`/updates/${encodeURIComponent((await params).id)}`); }
