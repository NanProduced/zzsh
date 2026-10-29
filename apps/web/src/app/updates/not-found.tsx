import Link from 'next/link';
import { ServiceShell } from '@/components/layout/service-shell';
import './updates.css';
export default function UpdateNotFound() { return <div className="platform-updates-center"><ServiceShell title="平台动态" showBack={false} contextLabel={null} breadcrumbs={[{label:'首页',href:'/'},{label:'平台动态',href:'/updates'},{label:'动态不存在'}]}><section className="updates-empty"><h2>这条动态暂不可查看</h2><p>内容可能已撤回，或链接已经失效。</p><Link className="button secondary" href="/updates">返回平台动态</Link></section></ServiceShell></div>; }
