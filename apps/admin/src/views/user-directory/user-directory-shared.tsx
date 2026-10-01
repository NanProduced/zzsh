import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircleIcon, CopyIcon, InfoIcon, LockKeyholeIcon, RefreshCwIcon, ShieldCheckIcon, TriangleAlertIcon, UserRoundIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { WorkspacePageContent } from '@/workspace/page-content';
import { PERMISSION, STATUS_LABEL, sourceLabel, type Audit, type Domain, type Order, type Part, type Resource, type User, type UserDirectoryBff } from './user-directory-data';
import { friendlyError } from '../../api';
import { BEIJING_TIME_ZONE } from '../../workspace/beijing-time';
export type PageProps = Pick<Parameters<typeof WorkspacePageContent>[0], 'tab' | 'snapshot' | 'onOpenPath' | 'onQueryChange' | 'refreshNonce'>;
export type UserDirectoryData = UserDirectoryBff;
type RequestState<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; error: Error };
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {timeZone:BEIJING_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
export const time = (value:string|null|undefined) => !value ? '未提供' : Number.isNaN(Date.parse(value)) ? '时间未知' : dateFormatter.format(new Date(value));
export const isDirectoryInputError = (error:unknown) => error instanceof Error && ['注册日期无效','注册起始日期不能晚于结束日期'].includes(error.message);
export const errorText = (error:unknown) => isDirectoryInputError(error) ? (error as Error).message : friendlyError(error);

export function useDirectoryRequest<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const loader = useRef(load); loader.current = load;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; value: RequestState<T> }>({ key: '', value: { state: 'loading' } });
  useEffect(() => {
    const controller = new AbortController();
    setResult({ key, value: { state: 'loading' } });
    void loader.current(controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ key, value: { state: 'ready', data } });
    }).catch(error => {
      if (!controller.signal.aborted && error.name !== 'AbortError') setResult({ key, value: { state: 'error', error } });
    });
    return () => controller.abort();
  }, [key, attempt]);
  return { result: result.key === key ? result.value : { state: 'loading' } as RequestState<T>, retry: () => setAttempt(n => n + 1) };
}

export function Message({ kind = 'info', title, children, retry }: { kind?: 'info' | 'denied' | 'empty' | 'error' | 'success'; title: string; children?: ReactNode; retry?: () => void }) {
  const Icon = kind === 'denied' ? LockKeyholeIcon : kind === 'error' ? TriangleAlertIcon : kind === 'success' ? CheckCircleIcon : InfoIcon;
  return <div className={`ud-message ud-message-${kind}`} role={kind === 'error' ? 'alert' : 'status'}><Icon size={18} aria-hidden /><div><strong>{title}</strong>{children ? <div className="ud-message-body">{children}</div> : null}</div>{retry ? <Button variant="outline" onClick={retry}><RefreshCwIcon size={14} />重试</Button> : null}</div>;
}
export function Denied({ permission }: { permission: string }) {
  const domain = ({ [PERMISSION.orders]: '订单', [PERMISSION.resources]: '资源账号', [PERMISSION.support]: '客服上下文', [PERMISSION.audit]: '账号安全审计', 'user.account.restore': '账号恢复' } as Record<string, string>)[permission] ?? '此功能';
  return <Message kind="denied" title={`${domain}无权限`}>当前管理员无法读取或操作此领域，该分区不参与判断。<details className="ud-permission-code"><summary>查看权限要求</summary><code>{permission}</code></details></Message>;
}
export function Loading() { return <div className="ud-loading" role="status" aria-label="正在加载"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><span className="sr-only">正在读取用户信息</span></div>; }
export function CopyId({ id }: { id: string }) {
  const [notice, setNotice] = useState('');
  return <span className="ud-id"><code>{id}</code><Button variant="ghost" size="icon-sm" aria-label={`复制用户 ID ${id}`} onClick={e => { e.stopPropagation(); void navigator.clipboard.writeText(id).then(() => setNotice('已复制用户 ID')).catch(() => setNotice('复制失败，请选择用户 ID')); }}><CopyIcon size={14} /></Button><span className="sr-only" role="status">{notice}</span></span>;
}
export function Status({ user }: { user: User }) { return <Badge variant={user.status === 'ACTIVE' ? 'secondary' : 'outline'}><ShieldCheckIcon size={12} />{STATUS_LABEL[user.status]}</Badge>; }
export function Identity({ user, full = false, heading = false }: { user: User; full?: boolean; heading?: boolean }) {
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (heading) title.current?.focus({ preventScroll: true }); }, [heading, user.id]);
  return <div className="ud-identity"><span className="ud-avatar"><UserRoundIcon size={20} /></span><div className="min-w-0">{heading ? <h1 ref={title} tabIndex={-1}>{user.name || '未设置名称'}</h1> : <strong>{user.name || '未设置名称'}</strong>}{full ? <CopyId id={user.id} /> : <span className="ud-subline">{user.id}</span>}<span className="ud-subline">{user.provider === 'legacy_mysql_restore' && user.username ? `旧用户名：${user.username} · ` : ''}{user.phoneMasked}</span><span className="ud-subline">实名：{user.identity} · 年龄：{user.age}</span><span className="ud-source">{sourceLabel(user.provider)}</span>{user.match ? <span className="ud-match">匹配依据：{user.match}</span> : null}{user.legacyId && (full || user.match === '旧平台 ID') ? <span className="ud-subline">旧平台 ID：{user.legacyId}（辅助定位）</span> : null}</div></div>;
}
export function Summary({ part, kind }: { part: Part<Order[] | Resource[]>; kind: 'orders' | 'resources' }) {
  if (part.state === 'denied') return <span className="ud-muted">无权限</span>;
  if (kind === 'resources') return <span>{part.count === undefined ? `本页 ${part.data.length} 个` : part.count ? `${part.count} 个` : '暂无资源账号'}<span className="ud-subline">授权游戏范围内</span></span>;
  const current = part.current;
  if (current === undefined) return <span className="ud-muted">订单摘要暂未接入</span>;
  return <span>{current ? `${current} 个进行中` : '暂无进行中订单'}<span className="ud-subline">订单权限范围内</span></span>;
}
export function Recent({ user }: { user: User }) {
  return <span className="ud-muted">业务活动暂未接入</span>;
}

export function DomainBlock({ adapter, id, domain, refreshNonce, filters = {}, children }: { adapter: UserDirectoryData; id: string; domain: Domain; refreshNonce: number; filters?: Record<string,string>; children: (data: Order[] | Resource[] | Audit[] | string[]) => ReactNode }) {
  const filterKey=JSON.stringify(filters);
  const key=`${id}:${domain}:${refreshNonce}:${filterKey}`;
  const [page,setPage]=useState<{key:string;cursors:(string|undefined)[];index:number}>({key,cursors:[undefined],index:0});
  const current=page.key===key?page:{key,cursors:[undefined],index:0};
  const cursor=current.cursors[current.index];
  const { result, retry } = useDirectoryRequest(`${key}:${cursor??''}`, signal => adapter.section(id, domain, signal,cursor,filters));
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') return <Message kind="error" title={`${domain === 'orders' ? '订单' : domain === 'resources' ? '资源' : domain === 'audit' ? '审计' : '客服上下文'}加载失败`} retry={retry}>{errorText(result.error)}；其他分区仍可使用。</Message>;
  if (result.data.state === 'denied') return <Denied permission={result.data.permission} />;
  const next=result.data.nextCursor;
  return <>{children(result.data.data)}{domain!=='support' && (result.data.data.length>0||current.index>0) ? <div className="ud-pagination"><span>本页已读取 {result.data.data.length} 条</span><div><Button variant="outline" disabled={current.index===0} onClick={()=>setPage({...current,index:current.index-1})}>上一页</Button><Button variant="outline" disabled={!next} onClick={()=>setPage({key,cursors:[...current.cursors.slice(0,current.index+1),next!],index:current.index+1})}>下一页</Button></div></div>:null}</>;
}

