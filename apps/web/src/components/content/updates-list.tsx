'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, ArrowLeft, Pin } from 'lucide-react';
import type { UpdatesPage } from '@zzsh/content/updates';
import { updateListHref, updateDate, updateTypeLabel, type UpdateFilter } from '@/lib/platform-updates';

const positionKey = (url: string) => `zzsh.updates.position:${url}`;
export function UpdatesList({ data, type, restore = false }: { data: UpdatesPage; type: UpdateFilter; restore?: boolean }) {
  const router = useRouter(), listUrl = updateListHref(type, data.page);
  useEffect(() => {
    if (!restore) return;
    let frame = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(positionKey(listUrl)) || 'null');
      if (saved && Number.isFinite(saved.y) && saved.y >= 0 && Date.now() - saved.at < 30 * 60_000) frame = requestAnimationFrame(() => { window.scrollTo(0, saved.y); router.replace(listUrl, { scroll: false }); });
    } catch { /* A damaged optional scroll position must not prevent reading. */ }
    if (!frame) router.replace(listUrl, { scroll: false });
    return () => cancelAnimationFrame(frame);
  }, [restore, listUrl, router]);
  useEffect(() => {
    const serverNow = Date.parse(data.asOf), ends = data.items.flatMap(x => [x.settings.validUntil, x.settings.pinnedUntil]).filter((x): x is string => !!x).map(Date.parse).filter(x => x > serverNow);
    if (!ends.length) return;
    const timer = setTimeout(() => router.refresh(), Math.min(3_600_000, Math.max(100, Math.min(...ends) - serverNow + 50)));
    return () => clearTimeout(timer);
  }, [data, router]);
  const remember = () => { try { sessionStorage.setItem(positionKey(listUrl), JSON.stringify({ y: window.scrollY, at: Date.now() })); } catch { /* Browser back remains available without storage. */ } };
  const pages = Array.from(new Set([1, data.page - 1, data.page, data.page + 1, data.totalPages])).filter(x => x > 0 && x <= data.totalPages).sort((a, b) => a - b);
  return <>
    <div className="updates-toolbar"><nav className="updates-filters" aria-label="动态分类">{([['ALL', '全部'], ['ANNOUNCEMENT', '公告'], ['NEWS', '资讯']] as const).map(([value, label]) => <Link key={value} href={updateListHref(value)} aria-current={type === value ? 'page' : undefined}>{label}</Link>)}</nav><p className="updates-count">共 {data.total} 条{type === 'ALL' ? '动态' : updateTypeLabel(type)}</p></div>
    {data.items.length ? <ul className="updates-list">{data.items.map(item => <li key={item.id} data-pinned={item.pinned || undefined}>
      <Link href={`/updates/${encodeURIComponent(item.id)}?from=${encodeURIComponent(listUrl)}`} onClick={remember} className="updates-row">
        <div className="updates-row-labels"><span className={`update-kind update-kind--${item.type.toLowerCase()}`}>{updateTypeLabel(item.type)}</span>{item.pinned ? <span className="update-pin"><Pin size={11} aria-hidden="true" />置顶</span> : item.expired ? <span className="update-ended">已结束</span> : null}</div>
        <div className="updates-row-copy"><h2>{item.title}</h2>{item.summary ? <p>{item.summary}</p> : null}</div>
        {item.type === 'NEWS' && item.coverMediaId ? <img className="updates-thumbnail" src={`/api/content/media/${encodeURIComponent(item.coverMediaId)}/content`} alt="" loading="lazy" /> : null}
        <time dateTime={item.publishedAt}>{updateDate(item.publishedAt)}</time><ChevronRight size={18} aria-hidden="true" />
      </Link>
    </li>)}</ul> : <div className="updates-empty" role="status"><h2>{data.page > 1 ? '这一页没有动态' : '暂无已发布的动态'}</h2><p>平台公告和资讯发布后会在这里展示。</p>{data.page > 1 ? <Link href={updateListHref(type)}>返回第一页</Link> : null}</div>}
    {data.totalPages > 1 ? <nav className="updates-pagination" aria-label="动态分页">{data.page > 1 ? <Link href={updateListHref(type, data.page - 1)} rel="prev">上一页</Link> : <span aria-disabled="true">上一页</span>}{pages.map((page, index) => <span key={page}>{index > 0 && page - pages[index - 1]! > 1 ? <span className="updates-ellipsis">…</span> : null}<Link href={updateListHref(type, page)} aria-current={page === data.page ? 'page' : undefined} aria-label={`第${page}页`}>{page}</Link></span>)}{data.page < data.totalPages ? <Link href={updateListHref(type, data.page + 1)} rel="next">下一页</Link> : <span aria-disabled="true">下一页</span>}</nav> : null}
  </>;
}
export function UpdateBackLink({ href }: { href: string }) { return <Link className="update-back" href={href} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回平台动态</Link>; }
