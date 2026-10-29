import { ServiceShell } from '@/components/layout/service-shell';
import { UpdatesList } from '@/components/content/updates-list';
import { loadPlatformUpdates } from '@/lib/updates-server';
import type { UpdateFilter } from '@/lib/platform-updates';
import './updates.css';
export const dynamic = 'force-dynamic';
export const metadata = { title: '平台动态 · 洲洲商行', description: '平台公告、服务更新与最新资讯。' };
export default async function PlatformUpdatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams, type: UpdateFilter = query.type === 'ANNOUNCEMENT' || query.type === 'NEWS' ? query.type : 'ALL';
  const page = typeof query.page === 'string' && /^[1-9]\d{0,3}$/.test(query.page) ? Number(query.page) : 1;
  const data = await loadPlatformUpdates(type, page);
  return <div className="platform-updates-center platform-updates-center--index"><ServiceShell title="平台动态" showPageHeading={false} headingInContent showBack={false} contextLabel={null} breadcrumbs={[{ label: '首页', href: '/' }, { label: '平台动态' }]}>
    <header className="updates-welcome">
      <div className="updates-welcome-copy"><h1>平台动态</h1><p>平台公告、服务更新与最新资讯。</p></div>
      <picture className="updates-welcome-art" aria-hidden="true"><source type="image/webp" srcSet="/images/updates/zhouzhou-announcer-v1-400.webp 400w, /images/updates/zhouzhou-announcer-v1-800.webp 800w" sizes="(max-width: 640px) 135px, 350px" /><img src="/images/updates/zhouzhou-announcer-v1-800.webp" width={800} height={533} alt="" fetchPriority="high" decoding="async" /></picture>
    </header>
    <UpdatesList data={data} type={type} restore={query.restore === '1'} />
  </ServiceShell></div>;
}
