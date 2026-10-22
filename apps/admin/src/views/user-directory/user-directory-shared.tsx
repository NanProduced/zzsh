import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircleIcon, CopyIcon, HistoryIcon, InfoIcon, LockKeyholeIcon, RefreshCwIcon, ShieldCheckIcon, TriangleAlertIcon, UserRoundIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkspacePageContent } from '@/workspace/page-content';
import { PERMISSION, STATUS_LABEL, knownCount, type Audit, type Domain, type Order, type Part, type Resource, type User, type UserDirectoryBff } from './user-directory-data';
import { AdminApiError, friendlyError, type UserDirectoryWalletSummary } from '../../api';
import { BEIJING_TIME_ZONE } from '../../workspace/beijing-time';
export type PageProps = Pick<Parameters<typeof WorkspacePageContent>[0], 'tab' | 'snapshot' | 'onOpenPath' | 'onQueryChange' | 'refreshNonce'>;
export type UserDirectoryData = UserDirectoryBff;
type RequestState<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; error: Error };
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {timeZone:BEIJING_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
export const time = (value:string|null|undefined) => !value ? '未提供' : Number.isNaN(Date.parse(value)) ? '时间未知' : dateFormatter.format(new Date(value));
export const isDirectoryInputError = (error:unknown) => error instanceof Error && ['注册日期无效','注册起始日期不能晚于结束日期','信用分范围应为 0–100，最低分不能大于最高分'].includes(error.message);
export const errorText = (error:unknown) => isDirectoryInputError(error) ? (error as Error).message : friendlyError(error);
/** 只有不自明的命中依据需要提示；昵称与用户名命中由界面本身说明。 */
export const MATCH_REASON_LABEL: Record<string, string> = {
  '用户 ID': '按用户 ID 命中',
  '旧平台 ID': '按旧平台 ID 命中',
  '手机号精确匹配': '按手机号精确命中',
};
export const ORDER_CONDITION_LABEL: Record<'status' | 'role', Record<string, string>> = {
  status: { current: '当前订单（待付/已付）', PENDING_PAYMENT: '待支付', PAID: '已支付', COMPLETED: '已完成', CANCELLED: '已取消' },
  role: { renter: '租用方', owner: '资源归属方' },
};
const conditionTerms = (filters: Record<string, string>) => Object.entries(filters)
  .map(([key, value]) => (key === 'status' || key === 'role' ? ORDER_CONDITION_LABEL[key][value] : undefined) ?? `${key}=${value}`)
  .join('、');

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

/** 说明型提示：正文只留事实，来源、口径与依赖说明收进 Tooltip。 */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} aria-label={label} className="ud-hint" />}>
        <InfoIcon size={12} aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

export function CopyId({ id, name }: { id: string; name?: string }) {
  const [notice, setNotice] = useState('');
  return (
    <span className="ud-id">
      <Tooltip>
        <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="ud-copy-id" aria-label={name ? `复制用户ID：${name}` : '复制用户ID'} onClick={e => { e.stopPropagation(); void navigator.clipboard.writeText(id).then(() => setNotice('已复制用户 ID')).catch(() => setNotice('复制失败，请在详情页读取用户 ID')); }} />}>
          <CopyIcon size={14} aria-hidden />
        </TooltipTrigger>
        <TooltipContent>复制用户ID</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status">{notice}</span>
    </span>
  );
}

/** 账号状态语义色：正常低饱和绿、受限黄、冻结/停用等危险红、停用注销低强调、未知灰。 */
export const STATUS_TONE: Record<string, 'success' | 'warning' | 'destructive' | 'outline' | 'unknown'> = {
  ACTIVE: 'success',
  RESTRICTED: 'warning',
  DEACTIVATED: 'destructive',
  CANCELLED: 'outline',
  UNKNOWN: 'unknown',
};
export function Status({ user }: { user: User }) {
  const tone = STATUS_TONE[user.status] ?? 'unknown';
  return <Badge variant={tone === 'destructive' ? 'destructive' : tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : tone === 'unknown' ? 'unknown' : 'outline'}><ShieldCheckIcon size={12} aria-hidden />{STATUS_LABEL[user.status] ?? '未知'}</Badge>;
}
/** 实名状态独立于账号状态：未知不当未实名。 */
export const IDENTITY_TONE: Record<string, 'success' | 'warning' | 'destructive' | 'unknown'> = {
  VERIFIED: 'success',
  UNVERIFIED: 'warning',
  REJECTED: 'destructive',
  UNKNOWN: 'unknown',
};
export const IDENTITY_TEXT: Record<string, string> = {
  VERIFIED: '已实名',
  UNVERIFIED: '未实名',
  REJECTED: '未通过',
  UNKNOWN: '实名未知',
};
export function IdentityStatus({ value }: { value: string }) {
  const tone = IDENTITY_TONE[value] ?? 'unknown';
  return <Badge variant={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : tone === 'destructive' ? 'destructive' : 'unknown'}>{IDENTITY_TEXT[value] ?? '实名未知'}</Badge>;
}

/** 头像：只用服务端给出的真实 image，缺失或坏图回退到图标，不生成或伪装肖像。 */
export function UserAvatar({ user, size = 'default' }: { user: User; size?: 'sm' | 'default' | 'lg' }) {
  return (
    <Avatar size={size} className="ud-avatar">
      {user.image ? <AvatarImage src={user.image} alt="" /> : null}
      <AvatarFallback><UserRoundIcon size={size === 'lg' ? 22 : 16} aria-hidden /></AvatarFallback>
    </Avatar>
  );
}

export function Identity({ user, full = false, heading = false, onOpenDetail }: { user: User; full?: boolean; heading?: boolean; onOpenDetail?: (user: User) => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (heading) title.current?.focus({ preventScroll: true }); }, [heading, user.id]);
  const migrated = user.provider === 'legacy_mysql_restore';
  const nickname = user.name || '未设置名称';
  const longNickname = nickname.length > 12;
  return (
    <div className="ud-identity">
      <UserAvatar user={user} />
      <div className="min-w-0">
        <div className="ud-identity-name">
          {heading ? (
            <h1 ref={title} tabIndex={-1}>{nickname}</h1>
          ) : onOpenDetail ? (
            <Tooltip>
              <TooltipTrigger
                render={<Button type="button" variant="link" className="ud-nickname" aria-label={`查看用户 ${nickname} 详情`} onClick={e => { e.stopPropagation(); onOpenDetail(user); }} />}
              >
                {nickname}
              </TooltipTrigger>
              {longNickname ? <TooltipContent className="max-w-64">{nickname}</TooltipContent> : null}
            </Tooltip>
          ) : (
            <strong>{nickname}</strong>
          )}
          <RiskBadge flagged={user.riskFlag === true} />
          {migrated ? (
            <Tooltip>
              <TooltipTrigger render={<span className="ud-source-icon" aria-label="旧平台迁入" tabIndex={0} onClick={e => e.stopPropagation()} />}>
                <HistoryIcon aria-hidden />
              </TooltipTrigger>
              <TooltipContent>旧平台迁入</TooltipContent>
            </Tooltip>
          ) : null}
          <CopyId id={user.id} name={user.name} />
        </div>
        <span className="ud-subline">{user.phoneMasked}</span>
        {user.match && MATCH_REASON_LABEL[user.match] ? <span className="ud-match">{MATCH_REASON_LABEL[user.match]}</span> : null}
      </div>
    </div>
  );
}

const dateOnlyFormatter = new Intl.DateTimeFormat('zh-CN', {timeZone:BEIJING_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
export const formatBeijingDate = (value: string | null | undefined) => !value ? '未提供' : Number.isNaN(Date.parse(value)) ? '日期未知' : dateOnlyFormatter.format(new Date(value)).replace(/\//g, '-');

/**
 * 注册时间只读服务端声明的来源：LEGACY 是旧平台注册时间，LOCAL 是本平台注册时间，UNKNOWN 没有可核事实。
 * 不退回本地建档时间、updatedAt 或旧来源追溯时间，也不从用户名或迁入标签推断来源。
 */
export function RegistrationCell({ user, includeTime = false }: { user: User; includeTime?: boolean }) {
  if (user.registeredAtSource === 'UNKNOWN' || !user.registeredAt || !Number.isFinite(Date.parse(user.registeredAt))) return <Badge variant="unknown">待核</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ud-registered-cell text-xs tabular-nums" tabIndex={0} aria-label="用户原注册时间" />}>
        {includeTime ? time(user.registeredAt) : formatBeijingDate(user.registeredAt)}
      </TooltipTrigger>
      <TooltipContent>用户原注册时间</TooltipContent>
    </Tooltip>
  );
}

/** 可用余额：精确整数分。未知与无权限都不是 0；金额不经过浮点。 */
export function WalletCell({ summary }: { summary?: UserDirectoryWalletSummary }) {
  if (!summary) return <span className="ud-muted">待核</span>;
  if (summary.state === 'denied') return <span className="ud-muted">无权限</span>;
  if (summary.state === 'unknown') return <span className="ud-muted">待核</span>;
  const cents = summary.amountCents;
  if (!/^-?(0|[1-9]\d{0,23})$/.test(cents)) return <span className="ud-muted">待核</span>;
  const negative = cents.startsWith('-');
  const absolute = (negative ? cents.slice(1) : cents).padStart(3, '0');
  const yuan = `${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ud-wallet-cell text-xs tabular-nums" tabIndex={0} aria-label="当前可用余额" />}>
        {negative ? '-' : ''}¥{yuan}
      </TooltipTrigger>
      <TooltipContent>当前可用余额，不含已申请提现部分</TooltipContent>
    </Tooltip>
  );
}

/** 内部高危标识：只读展示，与昵称同排；不联动账号状态、信用、上架或订单资格。 */
export function RiskBadge({ flagged }: { flagged: boolean }) {
  if (!flagged) return null;
  return <Badge variant="destructive" className="ud-risk-badge"><TriangleAlertIcon size={12} aria-hidden />高危</Badge>;
}

/** 正式等级名：普通、银卡、金卡、铂金、钻石；黑金是独立资格事实，不写作会员档位。 */
export const TIER_LABEL: Record<string, string> = {
  STANDARD: '普通会员',
  SILVER: '银卡会员',
  GOLD: '金卡会员',
  PLATINUM: '铂金会员',
  DIAMOND: '钻石会员',
  UNKNOWN: '等级待核',
};
export const SOURCE_STATE_LABEL: Record<string, string> = {
  COMPLETE: '核证完整',
  BACKFILL_PENDING: '资料待补',
  READ_FAILED: '读取失败',
  SOURCE_CONFLICT: '来源冲突',
  NO_POLICY: '无政策',
};
/** 礼遇状态：只有 ACTIVE 算当前有效，其余保留各自状态，不并入有效礼遇。 */
export const ENTITLEMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '生效中',
  PENDING: '待批准',
  APPROVED_PENDING_EXECUTION: '已批准待执行',
  EXECUTED_PENDING_START: '未开始',
  EXPIRED: '已过期',
  REPLACED: '已被替换',
  REVOKED: '已撤销',
};

export function MembershipSummaryCell({ summary }: { summary?: User['membershipSummary'] }) {
  if (summary?.state === 'denied') return <span className="ud-muted">无权限</span>;
  const growth = summary?.state === 'ready' ? summary.growth : undefined;
  if (!summary || !growth) return <span className="ud-muted">成长待更新</span>;
  // UNKNOWN/null 一律待核，不兜底成普通会员。
  const tierText = growth.knowledge === 'KNOWN'
    ? (growth.effectiveTier == null ? '等级待核' : TIER_LABEL[growth.effectiveTier] ?? '等级待核')
    : '等级待核';
  const entitlementsKnown = Array.isArray(summary.entitlements);
  const activeEntitlements = entitlementsKnown ? summary.entitlements.filter(e => e.status === 'ACTIVE') : [];

  return (
    <div className="ud-growth-cell">
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant={growth.knowledge === 'KNOWN' && growth.effectiveTier != null ? 'secondary' : 'unknown'}>{tierText}</Badge>
        {activeEntitlements.map(e => (
          <Badge key={e.id} variant="outline" className="ud-entitlement">{e.label}</Badge>
        ))}
      </div>
      {/* 已确认当前生效礼遇为空时不占行；字段缺失或受限只标待核，不当作没有礼遇。 */}
      {entitlementsKnown ? null : (
        <span className="ud-subline">
          礼遇待核
          <Hint label="礼遇状态说明">当前读取范围没有返回礼遇字段，这里不推断用户没有礼遇；详情页按授权范围继续核对。</Hint>
        </span>
      )}
    </div>
  );
}

/** 信用分颜色只做提示，不替代分数文字，也不改变交易准入。 */
export const creditTone = (score: number) => score >= 80 ? 'success' : score >= 60 ? 'warning' : 'destructive';
export function CreditSummaryCell({ summary }: { summary?: User['creditSummary'] }) {
  if (summary?.state === 'denied') {
    if (summary.reason === 'NO_GAME_SCOPE') return <span className="ud-muted">未分配业务范围</span>;
    if (summary.reason === 'OUT_OF_SCOPE') return <span className="ud-muted">无对象权限</span>;
    return <span className="ud-muted">无权限</span>;
  }
  if (summary?.state !== 'ready') return <span className="ud-muted">信用待更新</span>;
  if (summary.knowledge === 'NOT_INITIALIZED') {
    return (
      <div className="ud-credit-cell">
        <Badge variant="unknown">未评分</Badge>
      </div>
    );
  }
  const score = typeof summary.score === 'number' && Number.isFinite(summary.score) ? summary.score : undefined;
  if (score === undefined) {
    return (
      <div className="ud-credit-cell">
        <Badge variant="unknown">信用分待核</Badge>
      </div>
    );
  }
  const tone = creditTone(score);
  return (
    <div className="ud-credit-cell">
      <Badge variant={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'destructive'}>{score} 分</Badge>
    </div>
  );
}

export function OrdersCurrentCell({
  user,
  onDrillDown
}: {
  user: User;
  onDrillDown: (role: 'renter' | 'owner') => void;
}) {
  const orders = user.orders;
  if (orders.state === 'denied') {
    return <span className="ud-muted">{orders.reason === 'NO_GAME_SCOPE' ? '未分配业务范围' : '无权限'}</span>;
  }
  const renter = orders.renterCurrent, owner = orders.ownerCurrent, current = orders.current;
  if (renter === undefined && owner === undefined) {
    // The role split is unknown: only the server total is a known fact, and it is not a de-duplicated sum of roles.
    if (current === undefined) return <span className="ud-muted">订单摘要待更新</span>;
    return <span className="ud-orders-cell text-xs tabular-nums">进行中 {current}</span>;
  }
  return (
    <div className="ud-orders-cell flex flex-wrap items-center gap-1">
      {renter === undefined ? <span className="ud-muted text-xs">租入待更新</span> : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" className="h-6 px-1.5 text-xs tabular-nums" onClick={e => { e.stopPropagation(); onDrillDown('renter'); }} aria-label={`查看用户 ${user.name} 租入订单`} />}>
            租入 {renter}
          </TooltipTrigger>
          <TooltipContent>进行中的订单，含待付款</TooltipContent>
        </Tooltip>
      )}
      {owner === undefined ? <span className="ud-muted text-xs">出租待更新</span> : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" className="h-6 px-1.5 text-xs tabular-nums" onClick={e => { e.stopPropagation(); onDrillDown('owner'); }} aria-label={`查看用户 ${user.name} 出租订单`} />}>
            出租 {owner}
          </TooltipTrigger>
          <TooltipContent>进行中的订单，含待付款</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** 上架数是服务端投影的真实上架档案数；缺字段保持待核，不用名下档案数或本页条数代替。 */
export function PublishedCountCell({
  user,
  onDrillDown
}: {
  user: User;
  onDrillDown: () => void;
}) {
  const resources = user.resources;
  if (resources.state === 'denied') {
    return <span className="ud-muted">{resources.reason === 'NO_GAME_SCOPE' ? '未分配业务范围' : '无权限'}</span>;
  }
  const published = resources.publishedCount;
  if (published === undefined) return <span className="ud-muted">上架数待更新</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="outline" size="sm" className="h-6 px-1.5 text-xs tabular-nums" onClick={e => { e.stopPropagation(); onDrillDown(); }} aria-label={`查看用户 ${user.name} 已上架游戏账号`} />}>
        上架 {published}
      </TooltipTrigger>
      <TooltipContent>已发布账号数，不代表当前可租</TooltipContent>
    </Tooltip>
  );
}

export function Summary({ part, kind }: { part: Part<Order[] | Resource[]>; kind: 'orders' | 'resources' }) {
  if (part.state === 'denied') return <span className="ud-muted">{part.reason === 'NO_GAME_SCOPE' ? '未分配业务范围' : '无权限'}</span>;
  if (kind === 'resources') {
    const count = knownCount(part.count);
    const published = knownCount(part.publishedCount);
    return <span>{count === undefined ? <span className="ud-muted">账号数待更新</span> : count ? `${count} 个` : '暂无资源账号'}{published === undefined ? null : <span className="ud-subline">已上架 {published}</span>}<span className="ud-subline">授权游戏范围内</span></span>;
  }
  const current = knownCount(part.current);
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
  if (result.state === 'error') {
    const domainLabel = domain === 'orders' ? '订单' : domain === 'resources' ? '资源' : domain === 'audit' ? '审计' : '客服上下文';
    const refusedCondition = result.error instanceof AdminApiError && result.error.status === 400 && Object.keys(filters).length > 0;
    if (refusedCondition) return <Message kind="error" title={`${domainLabel}筛选条件不可用`}>接口拒绝了“{conditionTerms(filters)}”这一条件，页面未把它改成查询全部，条件已保留；请调整筛选条件。其他分区仍可使用。</Message>;
    return <Message kind="error" title={`${domainLabel}加载失败`} retry={retry}>{errorText(result.error)}；其他分区仍可使用。</Message>;
  }
  if (result.data.state === 'denied') return <Denied permission={result.data.permission} />;
  const next=result.data.nextCursor;
  return <>{children(result.data.data)}{domain!=='support' && (result.data.data.length>0||current.index>0) ? <div className="ud-pagination"><span>本页已读取 {result.data.data.length} 条</span><div><Button variant="outline" disabled={current.index===0} onClick={()=>setPage({...current,index:current.index-1})}>上一页</Button><Button variant="outline" disabled={!next} onClick={()=>setPage({key,cursors:[...current.cursors.slice(0,current.index+1),next!],index:current.index+1})}>下一页</Button></div></div>:null}</>;
}
