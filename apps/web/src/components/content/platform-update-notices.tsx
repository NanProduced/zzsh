'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Megaphone, Pause, Play } from 'lucide-react';
import { updateVisibility, type PublicUpdate, type UpdateSurface } from '@zzsh/content/updates';
import { parseUpdatesPage, updateTypeLabel } from '@/lib/platform-updates';
import './platform-update-notices.css';

function useUpdateNotices(surface: 'home' | UpdateSurface, gameId?: string) {
  const [items, setItems] = useState<PublicUpdate[]>([]), [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'), [retry, setRetry] = useState(0), [now, setNow] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController(); let sequence = 0, clockOffset = 0;
    const load = async () => {
      const seq = ++sequence;
      try {
        const query = new URLSearchParams({ surface, limit: surface === 'home' ? '10' : '3' });
        if (gameId) query.set('gameId', gameId);
        const response = await fetch(`/api/content/updates?${query}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error();
        const data = parseUpdatesPage(await response.json());
        if (!controller.signal.aborted && seq === sequence) { clockOffset = Date.parse(data.asOf) - Date.now(); setNow(Date.now() + clockOffset); setItems(data.items); setState('ready'); }
      } catch { if (!controller.signal.aborted && seq === sequence) { setItems([]); setState('error'); } }
    };
    setItems([]); setState('loading'); void load();
    const refresh = setInterval(() => { if (!document.hidden) void load(); }, 60_000), clock = setInterval(() => setNow(Date.now() + clockOffset), 1000);
    return () => { controller.abort(); clearInterval(refresh); clearInterval(clock); };
  }, [surface, gameId, retry]);
  return { items: items.filter(x => surface === 'home' ? updateVisibility(x.settings, now).ticker : updateVisibility(x.settings, now).reminder && x.settings.surfaces.includes(surface)), state, retry: () => setRetry(n => n + 1) };
}
export function PlatformUpdateTicker() {
  const { items, state, retry } = useUpdateNotices('home');
  const [index, setIndex] = useState(0), [paused, setPaused] = useState(false), [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [reduced, setReduced] = useState(true), [visible, setVisible] = useState(true);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReduced(query.matches), visibility = () => setVisible(!document.hidden);
    change(); visibility(); query.addEventListener('change', change); document.addEventListener('visibilitychange', visibility);
    return () => { query.removeEventListener('change', change); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const running = items.length > 1 && !paused && !hovered && !focused && !reduced && visible, current = items[index % (items.length || 1)];
  useEffect(() => { if (!running) return; const timer = setInterval(() => setIndex(n => n + 1), 5000); return () => clearInterval(timer); }, [running, items.length]);
  return <div className="platform-update-ticker" data-running={running} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="platform-update-label"><Megaphone size={19} aria-hidden="true" />平台动态</span>
    <div className="platform-update-message" aria-live="off">{state === 'loading' ? <span role="status">正在读取…</span> : state === 'error' ? <span role="status">动态暂时无法读取 <button type="button" onClick={retry}>重试</button></span> : current ? <><span className={`ticker-kind ticker-kind--${current.type.toLowerCase()}`}>{updateTypeLabel(current.type)}</span><Link href={`/updates/${encodeURIComponent(current.id)}`} title={current.title}>{current.title}</Link></> : null}</div>
    {items.length > 1 ? <button className="platform-update-pause" type="button" disabled={reduced} aria-label={reduced ? '减少动态：平台动态已暂停' : paused ? '恢复平台动态轮播' : '暂停平台动态轮播'} onClick={() => setPaused(x => !x)}>{paused || reduced ? <Play size={14} /> : <Pause size={14} />}</button> : null}
    <Link className="platform-update-all" href="/updates">查看全部 <span aria-hidden="true">→</span></Link>
  </div>;
}
export function BusinessUpdateNotices({ surface, gameId }: { surface: UpdateSurface; gameId?: string }) {
  const { items, state, retry } = useUpdateNotices(surface, gameId);
  if (state === 'loading') return <p className="business-update-state" role="status">正在读取相关平台提醒…</p>;
  if (state === 'error') return <div className="business-update-state" role="status">相关平台提醒暂时无法读取。<button type="button" onClick={retry}>重试</button></div>;
  if (!items.length) return null;
  return <aside className="business-update-notices" aria-label="相关平台提醒"><h2><Megaphone size={16} aria-hidden="true" />相关平台提醒</h2><ul>{items.map(item => <li key={item.id}><Link href={`/updates/${encodeURIComponent(item.id)}`}>{item.title}<span aria-hidden="true"> →</span></Link>{item.settings.impact ? <p>影响范围：{item.settings.impact}</p> : null}{item.settings.effectiveAt ? <p>生效时间：<time dateTime={item.settings.effectiveAt}>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.settings.effectiveAt))}</time></p> : null}</li>)}</ul></aside>;
}
