'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ServiceShell } from '@/components/layout/service-shell';
import './updates.css';
export default function UpdatesError({ reset }: { reset: () => void }) { const router = useRouter(); return <div className="platform-updates-center"><ServiceShell title="平台动态" showBack={false} contextLabel={null} breadcrumbs={[{label:'首页',href:'/'},{label:'平台动态'}]}><section className="updates-empty" role="alert"><h2>平台动态暂时无法读取</h2><p>请稍后重试，已发布内容不会因此被删除。</p><button className="button secondary" onClick={() => { router.refresh(); reset(); }}>重新读取</button><Link className="button quiet" href="/">返回首页</Link></section></ServiceShell></div>; }
