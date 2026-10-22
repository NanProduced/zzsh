import { accountNumberLabel, historicalReadSummary } from "../supply-review/model";
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { restoreTabs, tabHref, tabFromLocation, type WorkspaceTab } from '@/workspace/tab-model';
import { AdminApiError } from '../../api';
import { PERMISSION, STATUS_LABEL, sourceLabel, type Audit, type Order, type Resource, type User } from './user-directory-data';
import {
  Denied,
  DomainBlock,
  ENTITLEMENT_STATUS_LABEL,
  Identity,
  IdentityStatus,
  RegistrationCell,
  Loading,
  Message,
  Status,
  Summary,
  MembershipSummaryCell,
  CreditSummaryCell,
  ORDER_CONDITION_LABEL,
  errorText,
  time,
  formatBeijingDate,
  TIER_LABEL,
  SOURCE_STATE_LABEL,
  useDirectoryRequest,
  type PageProps,
  type UserDirectoryData,
} from './user-directory-shared';
import { CreditPanel } from './credit-panel';
import { financeMoney, financeTime, bucketLabels, reasonLabels } from '../admin-finance-api';
import { registerFinanceOrigin } from '../admin-finance-view';

const SECTION_NAMES: Record<string, string> = {
  overview: '概览',
  orders: '订单记录',
  resources: '名下游戏账号',
  growth: '成长与礼遇',
  credit: '信用与保证金',
  finance: '资金',
  security: '账号安全',
};

const ORDER_STATUS: Record<string, string> = ORDER_CONDITION_LABEL.status;

const AUDIT_ACTION_LABEL: Record<string, string> = {
  'user.account.restored': '账号恢复',
  'user.account.deactivated': '账号停用',
  'user.account.cancelled': '账号注销',
  'user.identity.verification': '身份核验',
  'user.legacy_owner.migrated': '旧用户迁入记录',
};
const auditActionLabel = (action: string) => AUDIT_ACTION_LABEL[action] ?? '未识别操作';

function Orders({
  adapter,
  user,
  tab,
  refreshNonce,
  onOpenPath,
  onQueryChange,
}: {
  adapter: UserDirectoryData;
  user: User;
  tab: WorkspaceTab;
  refreshNonce: number;
  onOpenPath: PageProps["onOpenPath"];
  onQueryChange: PageProps["onQueryChange"];
}) {
  const [role, setRole] = useState(tab.query.role ?? '');
  const [status, setStatus] = useState(tab.query.status ?? '');

  useEffect(() => {
    setRole(tab.query.role ?? '');
    setStatus(tab.query.status ?? '');
  }, [tab.query.role, tab.query.status]);

  const handleRoleChange = (nextRole: string) => {
    setRole(nextRole);
    onQueryChange({
      section: 'orders',
      ...(nextRole ? { role: nextRole } : {}),
      ...(status ? { status } : {}),
    });
  };

  const handleStatusChange = (nextStatus: string) => {
    setStatus(nextStatus);
    onQueryChange({
      section: 'orders',
      ...(role ? { role } : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
    });
  };

  const filters = { ...(role ? { role } : {}), ...(status ? { status } : {}) };

  return (
    <>
      <div className="ud-section-heading">
        <h2>订单记录</h2>
        <span className="ud-muted">授权游戏范围内 · 一行一单 · 支持参与角色与当前订单筛选</span>
      </div>
      <div className="ud-order-filters flex flex-wrap gap-4 items-center mb-4">
        <Field label="参与角色" className="w-48" composite>
          <Select items={{ ALL: '全部角色', ...ORDER_CONDITION_LABEL.role }} value={role || 'ALL'} onValueChange={v => handleRoleChange(!v || v === 'ALL' ? '' : String(v))}>
            <SelectTrigger aria-label="该用户在具体订单中的参与方">
              <SelectValue placeholder="全部角色" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部角色</SelectItem>
              <SelectItem value="renter">租用方</SelectItem>
              <SelectItem value="owner">资源归属方</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="订单状态" className="w-56" composite>
          <Select items={{ ALL: '全部状态', ...ORDER_STATUS }} value={status || 'ALL'} onValueChange={v => handleStatusChange(!v || v === 'ALL' ? '' : String(v))}>
            <SelectTrigger aria-label="订单状态">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部状态</SelectItem>
              {Object.entries(ORDER_STATUS).map(([key, label]) => (
                <SelectItem key={key} value={key}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <DomainBlock adapter={adapter} id={user.id} domain="orders" filters={filters} refreshNonce={refreshNonce}>
        {data => (data as Order[]).length ? (
          <div className="ud-order-list">
            {(data as Order[]).map(order => (
              <article key={order.orderId} className="ud-order" data-order-id={order.orderId}>
                <div className="ud-order-title">
                  <Button
                    variant="link"
                    className="oc-link h-auto p-0 text-primary font-medium inline-flex items-center gap-1"
                    onClick={() => onOpenPath(`/orders/${order.orderId}`, order.displayNo)}
                  >
                    {order.displayNo}
                    <ArrowUpRightIcon size={13} />
                  </Button>
                  <Badge variant="outline">{ORDER_STATUS[order.status] ?? `未知：${order.status}`}</Badge>
                  <Badge variant="secondary">本单{order.role === 'renter' ? '租用方' : '资源归属方'}</Badge>
                </div>
                <p>{order.title} · {order.accountDisplayNo == null ? '资源账号信息受限' : accountNumberLabel(order.accountDisplayNo)}</p>
                <dl className="ud-order-facts">
                  <div>
                    <dt>资源预付 / 押金 / 需付（订单记录）</dt>
                    <dd>CNY {order.amounts.rental?.amount ?? '未知'} / {order.amounts.deposit?.amount ?? '未知'} / {order.amounts.totalDue?.amount ?? '未知'}</dd>
                  </div>
                  <div>
                    <dt>支付时间</dt>
                    <dd>{order.paidAt ? time(order.paidAt) : order.payment?.state === 'RECORDED_PAID' || ['PAID', 'COMPLETED'].includes(order.status) ? '支付时间待确认' : '暂无可核验支付时间'}</dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{time(order.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>交易另一方</dt>
                    <dd>{order.counterpartyName || '昵称未设置'}</dd>
                  </div>
                  {order.status === 'CANCELLED' ? (
                    <div>
                      <dt>取消信息</dt>
                      <dd>{order.cancelReason ?? '原因未知'} · {time(order.cancelledAt)}</dd>
                    </div>
                  ) : null}
                  {order.expiredAwaitingCancel ? (
                    <div>
                      <dt>保留期</dt>
                      <dd>已过保留期，待服务端确认取消</dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <Message kind="empty" title="范围内暂无符合当前条件的订单">
            调整订单参与方或状态后重新查询。
          </Message>
        )}
      </DomainBlock>
      <Message title="履约上下文暂未接入用户目录">
        付款、加入订单群、交付与正式开租是独立事实；这里不推断履约进度。处理履约事项时须进一步核对该订单的事实记录。
      </Message>
    </>
  );
}

/** 版本发布事实：版本状态，不是账号当前的有效发布事实。 */
const PUBLICATION_VERSION_LABEL: Record<string, string> = { DRAFT: '未发布', SUBMITTED: '审核中', WITHDRAWN: '已下架', REJECTED: '已驳回', IMPORTED_UNVERIFIED: '旧资料待核' };

function publicationLabel(resource: Resource) {
  const publication = resource.publication;
  const version = publication.versionPublished
    ? publication.source === 'OWNER_DIRECT' ? '当前版本已直接发布' : '当前版本已按旧承接审核发布'
    : !resource.currentVersionId
      ? '未提交发布'
      : PUBLICATION_VERSION_LABEL[publication.versionState ?? ''] ?? `发布事实待确认（${publication.versionState ?? '未知'}）`;
  // currentlyPublished 是账号当前的有效发布事实；versionPublished 只是版本状态，不能代替它。
  if (publication.currentlyPublished === undefined) return `当前上架状态待核 · ${version}`;
  return `${publication.currentlyPublished ? '当前已上架' : '当前未上架'} · ${version}`;
}

function Resources({ adapter, user, tab, refreshNonce, onOpenPath, onQueryChange }: { adapter: UserDirectoryData; user: User; tab: WorkspaceTab; refreshNonce: number; onOpenPath: PageProps["onOpenPath"]; onQueryChange: PageProps["onQueryChange"] }) {
  const published = tab.query.publication === 'published';
  const filters: Record<string, string> = published ? { publication: 'published' } : {};
  return (
    <>
      <div className="ud-section-heading">
        <h2>名下游戏账号</h2>
        <span className="ud-muted">该用户关联的资源 · 授权游戏范围内</span>
      </div>
      <div className="ud-order-filters flex flex-wrap gap-4 items-center mb-4">
        <Field label="账号范围" className="w-48" composite>
          <Select items={{ ALL: '全部档案', published: '已上架' }} value={published ? 'published' : 'ALL'} onValueChange={v => onQueryChange({ section: 'resources', publication: v === 'published' ? 'published' : '' })}>
            <SelectTrigger aria-label="账号范围">
              <SelectValue placeholder="全部档案" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部档案</SelectItem>
              <SelectItem value="published">已上架</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <DomainBlock adapter={adapter} id={user.id} domain="resources" filters={filters} refreshNonce={refreshNonce}>
        {data => (data as Resource[]).length ? (
          <div className="ud-resource-list">
            {(data as Resource[]).map(resource => (
              <article className="ud-resource" key={resource.accountId}>
                <Button
                  variant="link"
                  className="oc-link h-auto p-0 text-primary font-medium inline-flex items-center gap-1"
                  onClick={() => onOpenPath(`/supply/accounts/${resource.accountId}`, `账号 ${resource.displayNo ?? ""}`)}
                >
                  {resource.displayNo ?? "编号待核"}
                  <ArrowUpRightIcon size={13} />
                </Button>
                {resource.historicalRead ? <p>{historicalReadSummary(resource.historicalRead)}。历史显示资料不代表当前可租。</p> : null}
                <p>{resource.game.name} · 生命周期：{resource.lifecycle === 'ACTIVE' ? '有效' : resource.lifecycle === 'ARCHIVED' ? '已归档' : `未知：${resource.lifecycle}`}</p>
                <p>发布者暂停：{resource.ownerPaused ? '是' : '否'} · 平台限制：{resource.staffRestricted ? '是' : '否'} · 旧平台保留：{resource.legacyHold === 'NONE' ? '无' : resource.legacyHold === 'ACTIVE_LEGACY' ? '旧单承接中' : resource.legacyHold === 'UNRESOLVED' ? '待核对' : resource.legacyHold}</p>
                <Badge variant="outline">{publicationLabel(resource)}</Badge>
                <p>发布事实不等于当前可租资格。</p>
              </article>
            ))}
          </div>
        ) : (
          <Message kind="empty" title={published ? '该用户当前没有已上架的游戏账号' : '范围内暂无名下游戏账号'}>
            {published ? '已按已上架范围查询；名下档案仍在“全部档案”中。' : '已按供给读取权限和游戏范围查询。'}
          </Message>
        )}
      </DomainBlock>
    </>
  );
}

function MembershipGrowthSection({
  adapter,
  user,
  refreshNonce,
  onOpenPath,
}: {
  adapter: UserDirectoryData;
  user: User;
  refreshNonce: number;
  onOpenPath: PageProps["onOpenPath"];
}) {
  const hasAccess = adapter.has(PERMISSION.growthSummary) || adapter.has(PERMISSION.growthDetail) || adapter.snapshot.security.isBoss;
  const { result, retry } = useDirectoryRequest(
    `${user.id}:membership-growth:${refreshNonce}`,
    signal => adapter.membershipGrowth(user.id, signal)
  );

  if (!hasAccess) return <Denied permission={PERMISSION.growthSummary} />;
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') {
    return (
      <Message kind="error" title="成长与礼遇详情读取失败" retry={retry}>
        {errorText(result.error)}；其他分区仍可使用。
      </Message>
    );
  }

  const data = result.data;
  const growth = data.growth;
  // DETAIL_ONLY 只授权按范围读取贡献明细，不是整主体摘要：等级与礼遇都没有读到。
  const detailOnly = data.authorizationState === 'DETAIL_ONLY';
  // 缺字段表示没读到；空数组表示读到且确实没有。两者都不当作"没有礼遇"。
  const entitlementsRead = Array.isArray(data.entitlements);
  const entitlements = entitlementsRead ? data.entitlements! : [];
  const activeEntitlements = entitlements.filter(e => e.status === 'ACTIVE');
  const historicalEntitlements = entitlements.filter(e => e.status !== 'ACTIVE');

  return (
    <>
      <div className="ud-section-heading">
        <h2>成长与礼遇</h2>
        <span className="ud-muted">只读成长事实与独立礼遇 · 独立授权读取</span>
      </div>

      <div className="ud-overview-grid mb-4">
        <div>
          <h3>成长事实</h3>
          {detailOnly ? (
            <Message kind="denied" title="读取范围受限">当前授权只允许按游戏范围读取贡献明细，未包含等级与礼遇摘要；下面的等级与礼遇不可判读。</Message>
          ) : null}
          <dl className="ud-facts">
            <div>
              <dt>有效会员等级</dt>
              <dd>
                <Badge variant={growth?.knowledge === 'KNOWN' && growth.effectiveTier != null ? 'secondary' : 'unknown'}>
                  {growth?.knowledge !== 'KNOWN' ? '等级待核' : growth.effectiveTier == null ? '等级待核' : TIER_LABEL[growth.effectiveTier] ?? '等级待核'}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>常规评定等级</dt>
              <dd>{growth?.normalTier == null ? '未评定' : TIER_LABEL[growth.normalTier] ?? '未评定'}</dd>
            </div>
            <div>
              <dt>黑金资格判定</dt>
              <dd>
                {growth?.blackGold === 'QUALIFIED' ? '已具备黑金资格' : growth?.blackGold === 'REVIEW_REQUIRED' ? '待人工复核' : growth?.blackGold === 'NOT_QUALIFIED' ? '未具备' : '未读取'}
              </dd>
            </div>
            <div>
              <dt>成长确知状态</dt>
              <dd>
                {growth?.knowledge === 'KNOWN' ? '已确知' : '成长数据未知'}
                {growth?.sourceState && growth.sourceState !== 'COMPLETE' ? ` · ${SOURCE_STATE_LABEL[growth.sourceState] ?? growth.sourceState}` : ''}
              </dd>
            </div>
            <div>
              <dt>权益政策状态</dt>
              <dd>
                {growth?.benefitsState === 'CONFIGURED' ? '已配置生效' : growth?.benefitsState === 'NOT_CONFIGURED' ? '权益政策尚未配置' : '未读取'}
              </dd>
            </div>
            {growth?.grace && growth.grace.state !== 'NONE' ? (
              <div>
                <dt>保级宽限期</dt>
                <dd>
                  状态：{growth.grace.state} · 原档位：{growth.grace.fromTier ? TIER_LABEL[growth.grace.fromTier] ?? growth.grace.fromTier : '无'} · 截止：{time(growth.grace.until)} · 差额：{growth.grace.gapPoints == null ? '未读取' : `${growth.grace.gapPoints} 积分`}
                </dd>
              </div>
            ) : null}
            {growth?.rollingPoints || growth?.lifetimePoints ? (
              <div>
                <dt>成长积分依据</dt>
                <dd>
                  滚动积分：{growth.rollingPoints ?? '—'} · 累计贡献：{growth.lifetimePoints ?? '—'}
                </dd>
              </div>
            ) : null}
            {data.sourceSummary ? (
              <div>
                <dt>贡献记录核验</dt>
                <dd>
                  来源记录：{data.sourceSummary.contributionCount} 条 · 待处理：{data.sourceSummary.pendingCount} 条 · 排除：{data.sourceSummary.excludedCount} 条
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        <div>
          <h3>当前有效独立礼遇</h3>
          {!entitlementsRead ? (
            <Message kind="denied" title="礼遇未读取">当前读取范围没有返回礼遇字段，这里不推断用户没有礼遇。</Message>
          ) : activeEntitlements.length > 0 ? (
            <div className="flex flex-col gap-2">
              {activeEntitlements.map(e => (
                <article key={e.id} className="p-3 border rounded-md text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{e.label}</Badge>
                    <Badge variant="secondary">{e.kind === 'PRESTIGE' ? '尊享礼遇' : '挚友礼遇'}</Badge>
                    <span className="ud-muted">{e.depositWaived ? '免押金' : '标准押金'}</span>
                  </div>
                  <p className="text-muted-foreground">范围：{e.scopeKey}</p>
                  <p className="text-muted-foreground">
                    有效期：{formatBeijingDate(e.startsAtUtc)} 至 {formatBeijingDate(e.endsAtUtc)}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <Message kind="empty" title="暂无有效独立礼遇">
              已读取礼遇字段，当前没有处于有效期内的独立礼遇。
            </Message>
          )}
          {historicalEntitlements.length > 0 ? (
            <details className="ud-entitlement-history">
              <summary>历史礼遇（{historicalEntitlements.length}）</summary>
              <ul>
                {historicalEntitlements.map(e => (
                  <li key={e.id}>
                    <Badge variant="outline">{e.label}</Badge>
                    <span className="ud-muted">{ENTITLEMENT_STATUS_LABEL[e.status] ?? e.status}</span>
                    <span className="ud-subline">{formatBeijingDate(e.startsAtUtc)} 至 {formatBeijingDate(e.endsAtUtc)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>

      {(adapter.has('membership.policy.draft') || adapter.snapshot.security.isBoss) ? (
        <div className="mb-4">
          <Button variant="outline" onClick={() => onOpenPath('/membership-growth')}>
            前往会员成长工作台
            <ArrowUpRightIcon size={14} />
          </Button>
        </div>
      ) : null}

      <Message title="成长与礼遇安全边界">
        独立礼遇按授予周期单独生效，不自动升级为全局会员档位，也不替代价格与交易范围授权；本界面仅提供只读事实核对，不提供政策审批或礼遇发放操作。
      </Message>
    </>
  );
}

function UserFinanceSection({
  adapter,
  user,
  refreshNonce,
  onOpenPath,
}: {
  adapter: UserDirectoryData;
  user: User;
  refreshNonce: number;
  onOpenPath: PageProps["onOpenPath"];
}) {
  const hasAccess = adapter.has(PERMISSION.finance) || adapter.snapshot.security.isBoss;
  const { result, retry } = useDirectoryRequest(
    `${user.id}:finance:${refreshNonce}`,
    signal => adapter.finance(user.id, signal)
  );

  if (!hasAccess) return <Denied permission={PERMISSION.finance} />;
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') {
    return (
      <Message kind="error" title="用户资金读取失败" retry={retry}>
        {errorText(result.error)}；其他分区仍可使用。
      </Message>
    );
  }

  const data = result.data;
  const wallet = data.wallet;

  return (
    <>
      <div className="ud-section-heading">
        <h2>用户资金</h2>
        <span className="ud-muted">钱包余额、准入覆盖与可提现责任 · 整数分金额口径</span>
      </div>

      {wallet ? (
        <div className="space-y-4 mb-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Object.entries(wallet.buckets).map(([key, bucket]) => {
              const label = bucketLabels[key.toUpperCase()] ?? (
                { available: '用户可用', reserved: '提现预留', restricted: '受限', pendingEarnings: '待结算收益', refundPayable: '退款应付' } as Record<string, string>
              )[key] ?? key;
              return (
                <div key={key} className="p-3 border rounded-md">
                  <span className="text-xs text-muted-foreground block mb-1">{label}</span>
                  <strong className="text-base font-semibold tabular-nums">{financeMoney(bucket.amountCents)}</strong>
                </div>
              );
            })}
          </div>

          <div className="p-3 border rounded-md flex flex-wrap justify-between items-center gap-2">
            <div>
              <span className="text-xs text-muted-foreground block">当前可提现金额</span>
              <strong className="text-lg font-bold text-primary tabular-nums">{financeMoney(wallet.withdrawable?.amountCents)}</strong>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">来源覆盖</span>
              <span className="text-sm">
                {wallet.coverage?.knowledge === 'KNOWN' ? `已准入 · 截止 ${financeTime(wallet.coverage.cutoff)}` : '未核定'}
              </span>
            </div>
          </div>

          {((wallet.withdrawable?.reasonCodes?.length ?? 0) > 0 || (data.gaps?.length ?? 0) > 0) ? (
            <div className="p-3 bg-muted/40 rounded-md text-xs space-y-1">
              <span className="font-medium text-muted-foreground block mb-1">资金缺项与核定说明</span>
              {[...(wallet.withdrawable?.reasonCodes ?? []), ...(data.gaps ?? [])].map(code => (
                <p key={code} className="text-muted-foreground">· {reasonLabels[code] ?? code}</p>
              ))}
            </div>
          ) : null}

          <div>
            <Button
              variant="default"
              onClick={() => {
                const identity = `${adapter.snapshot.adminUserId}:${adapter.snapshot.session.id}:${[...adapter.snapshot.permissions].sort().join("|")}`;
                const origin = registerFinanceOrigin(`/users/${user.id}?section=finance`, identity);
                onOpenPath(`/finance/users/${encodeURIComponent(user.id)}?origin=${encodeURIComponent(origin)}`, `${user.name || user.id} · 资金`);
              }}
            >
              进入完整资金核对
              <ArrowUpRightIcon size={14} />
            </Button>
          </div>
        </div>
      ) : (
        <Message kind="empty" title="暂无钱包数据">
          当前用户尚未形成权威钱包记录或尚未准入资金系统。
        </Message>
      )}

      <Message title="资金只读说明">
        此处仅展示服务端权威分账，不以订单交易金额推算钱包余额；退款应付与已到账分开展示；本处不进行任何充值、调账、提现或写操作。
      </Message>
    </>
  );
}

type RestoreResult = 'success' | 'rejected' | 'conflict' | 'failed' | 'pending' | 'readback-failed';
function Restore({ adapter, user, changed }: { adapter: UserDirectoryData; user: User; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<RestoreResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [read, setRead] = useState<User>();
  const [writeAccepted, setWriteAccepted] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  const clearSecrets = () => { setPassword(''); setCode(''); };
  const current = read ?? user;
  const hasRestoreAccess = adapter.has('user.account.restore');
  const eligible = hasRestoreAccess && !writeAccepted && current.status === 'DEACTIVATED';

  const reread = async () => {
    setBusy(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      const value = await adapter.detail(user.id, request.signal);
      if (request.signal.aborted) return;
      setRead(value);
      if (value.status === 'ACTIVE') {
        setResult('success'); setError(''); changed();
      } else if (writeAccepted) {
        setResult('readback-failed'); setError('恢复请求已被接受，但账号状态仍未显示为正常；不会自动重复提交。');
      }
    } catch (failure) {
      if (!request.signal.aborted) {
        setResult(currentResult => writeAccepted ? 'readback-failed' : currentResult);
        setError(errorText(failure));
      }
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };

  const submit = async () => {
    if (!eligible || result === 'pending' || writeAccepted) return;
    setError(''); setRead(undefined); setBusy(true);
    const request = new AbortController(); controller.current = request;
    try {
      await adapter.restore(user.id, reason, password, code, request.signal);
      if (request.signal.aborted) return;
      setWriteAccepted(true); setResult('success');
      try {
        const value = await adapter.detail(user.id, request.signal);
        if (request.signal.aborted) return;
        setRead(value);
        if (value.status === 'ACTIVE') {
          setResult('success'); setError(''); changed();
        } else {
          setResult('readback-failed'); setError('恢复请求已被接受，但账号状态仍未显示为正常；不会自动重复提交。');
        }
      } catch (readbackFailure) {
        if (!request.signal.aborted) {
          setResult('readback-failed'); setError(errorText(readbackFailure));
        }
      }
    } catch (failure) {
      if (request.signal.aborted) return;
      setResult(
        failure instanceof AdminApiError && failure.status === 0 ? 'pending' :
        failure instanceof AdminApiError && failure.status === 401 ? 'rejected' :
        failure instanceof AdminApiError && failure.status === 409 ? 'conflict' : 'failed'
      );
      setError(errorText(failure));
      try {
        const value = await adapter.detail(user.id, request.signal);
        if (!request.signal.aborted) setRead(value);
      } catch {
        /* The outcome remains unconfirmed when re-read also fails. */
      }
    } finally {
      clearSecrets();
      if (!request.signal.aborted) setBusy(false);
    }
  };

  const labels: Record<RestoreResult, string> = {
    success: '账号恢复已处理',
    rejected: '管理员再认证被拒绝',
    conflict: '账号状态已变化',
    failed: '恢复操作失败',
    pending: '恢复结果待确认',
    'readback-failed': '恢复请求已提交，状态待确认',
  };

  return (
    <div className="ud-restore">
      <h2>账号恢复</h2>
      {!hasRestoreAccess ? (
        <Denied permission="user.account.restore" />
      ) : (
        <>
          <p>
            {writeAccepted ? '恢复请求已被服务端接受；当前状态需要重读确认。' :
             eligible ? '已停用，可进入恢复评估。需操作原因与管理员密码/TOTP再认证。' :
             current.status === 'CANCELLED' ? '已注销账号不可恢复。' : '当前账号状态不符合恢复资格。'}
          </p>
          {writeAccepted ? (
            <Button variant="outline" onClick={() => setOpen(true)}>核对恢复结果</Button>
          ) : eligible ? (
            <Button variant="outline" onClick={() => setOpen(true)}>账号恢复</Button>
          ) : null}
        </>
      )}
      {(result === 'pending' || result === 'readback-failed') && !open ? (
        <Message title={labels[result]}>先核对服务端账号状态；不会自动重试或重复提交。</Message>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={value => {
          if (busy) return;
          setOpen(value);
          if (!value) { clearSecrets(); setReason(''); }
        }}
      >
        <DialogContent className="ud-restore-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>账号恢复评估 · {user.name}</DialogTitle>
            <DialogDescription>
              恢复只改变账号可用状态，不复活旧会话或验证凭据，不覆盖实名与年龄结果。
            </DialogDescription>
          </DialogHeader>
          <form aria-busy={busy} onSubmit={e => { e.preventDefault(); void submit(); }}>
            <Field label="操作原因（3–500字）" className="ud-field">
              <Textarea
                aria-label="操作原因"
                value={reason}
                minLength={3}
                maxLength={500}
                required
                onChange={e => setReason(e.target.value)}
              />
            </Field>
            <Field label="管理员密码" className="ud-field">
              <Input
                type="password"
                aria-label="管理员密码"
                autoComplete="off"
                value={password}
                minLength={12}
                required
                onChange={e => setPassword(e.target.value)}
              />
            </Field>
            <Field label="管理员 TOTP（6位）" className="ud-field">
              <Input
                type="password"
                inputMode="numeric"
                aria-label="管理员 TOTP"
                autoComplete="off"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                required
                onChange={e => setCode(e.target.value)}
              />
            </Field>
            {result ? (
              <Message
                kind={result === 'success' ? 'success' : result === 'pending' || result === 'readback-failed' ? 'info' : 'error'}
                title={labels[result]}
              >
                {read ? `重读账号状态：${STATUS_LABEL[read.status]}。` : '账号状态尚未确认。'}
                {result === 'success' ? '请用户重新登录；旧会话和验证凭据不会复活。' :
                 result === 'readback-failed' ? '恢复写入已成功，但状态回读未完成；不会自动重复提交。' :
                 result === 'pending' ? '未收到确认结果，请重新读取账号状态；不自动重复提交。' : '填写新的再认证信息后由管理员决定是否重试。'}
              </Message>
            ) : null}
            {error && result !== 'pending' && result !== 'readback-failed' ? (
              <Message kind="error" title="操作未完成">{error}</Message>
            ) : null}
            {error && result === 'readback-failed' ? (
              <Message kind="info" title="状态读取提示">{error}</Message>
            ) : null}
            <div className="ud-dialog-actions flex justify-end gap-2 mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => { setOpen(false); clearSecrets(); setReason(''); }}
              >
                关闭
              </Button>
              {result ? (
                <Button type="button" disabled={busy} onClick={() => void reread()}>
                  重新读取账号状态
                </Button>
              ) : null}
              {eligible && result !== 'pending' && result !== 'success' && result !== 'readback-failed' ? (
                <Button
                  type="submit"
                  disabled={busy || reason.trim().length < 3 || password.length < 12 || !/^\d{6}$/.test(code)}
                >
                  {busy ? '处理中…' : '提交恢复'}
                </Button>
              ) : null}
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function UserDetail({
  adapter,
  snapshot,
  tab,
  onOpenPath,
  onQueryChange,
  refreshNonce,
}: PageProps & { adapter: UserDirectoryData }) {
  const id = tab.objectId!;
  const [revision, setRevision] = useState(0);
  const { result, retry } = useDirectoryRequest(
    `${id}:${refreshNonce}:${revision}`,
    signal => adapter.detail(id, signal)
  );
  const section = tab.query.section && tab.query.section in SECTION_NAMES ? tab.query.section : 'overview';
  const [visited, setVisited] = useState(new Set([section]));
  useEffect(() => setVisited(current => new Set([...current, section])), [section]);

  const back = () => {
    const existing = restoreTabs(snapshot.adminUserId, {
      isBoss: snapshot.security.isBoss,
      permissions: snapshot.permissions,
    })?.tabs.find(item => item.id === 'users');
    onOpenPath(tabHref(existing ?? tabFromLocation('/users')));
  };

  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') {
    return (
      <>
        <Button variant="ghost" onClick={back}><ArrowLeftIcon size={16} />返回列表</Button>
        <Message kind="error" title="用户详情加载失败" retry={retry}>{errorText(result.error)}</Message>
      </>
    );
  }

  const user = result.data;

  return (
    <section className="ud-detail">
      <Button variant="ghost" onClick={back}><ArrowLeftIcon size={16} />返回列表</Button>
      <div className="ud-detail-heading">
        <Identity user={user} full heading />
        <Status user={user} />
      </div>
      <nav className="ud-sections flex flex-wrap gap-1 border-b pb-2 mb-4" aria-label="用户详情分区">
        {Object.entries(SECTION_NAMES).map(([key, label]) => (
          <Button
            variant={section === key ? 'secondary' : 'ghost'}
            key={key}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => onQueryChange({ section: key })}
          >
            {label}
          </Button>
        ))}
      </nav>

      {[...visited].map(view => (
        <div key={view} hidden={view !== section} className="ud-section-body">
          {view === 'overview' ? (
            <>
              <div className="ud-overview-grid">
                <div>
                  <h2>身份与账号</h2>
                  <dl className="ud-facts">
                    <div><dt>用户昵称</dt><dd>{user.name || '未设置昵称'}</dd></div>
                    <div><dt>用户ID</dt><dd className="break-all"><code>{user.id}</code></dd></div>
                    {user.legacyId ? <div><dt>旧平台ID</dt><dd>{user.legacyId}</dd></div> : null}
                    <div><dt>旧平台用户名</dt><dd>{user.provider === 'legacy_mysql_restore' ? user.displayUsername || user.username || '来源未提供' : '未关联旧平台用户名'}</dd></div>
                    <div><dt>实名</dt><dd><IdentityStatus value={user.identityStatus} /></dd></div>
                    <div><dt>年龄状态</dt><dd>{user.age}</dd></div>
                    <div><dt>实名通过时间</dt><dd>{time(user.verifiedAt)}</dd></div>
                    <div><dt>账号状态</dt><dd>{STATUS_LABEL[user.status]}</dd></div>
                    <div><dt>邮箱（脱敏）</dt><dd>{user.emailMasked ?? '未绑定真实邮箱'}</dd></div>
                    <div><dt>注册时间</dt><dd><RegistrationCell user={user} includeTime /></dd></div>
                    <div><dt>本平台建档（北京时间）</dt><dd>{time(user.createdAt)}</dd></div>
                  </dl>
                </div>
                <div>
                  <h2>关联业务</h2>
                  <div className="ud-business-links space-y-3">
                    <div>
                      <Summary kind="orders" part={user.orders} />
                      {adapter.has(PERMISSION.orders) ? (
                        <Button variant="outline" size="sm" onClick={() => onQueryChange({ section: 'orders' })}>
                          查看订单记录
                        </Button>
                      ) : (
                        <Denied permission={PERMISSION.orders} />
                      )}
                    </div>
                    <div>
                      <Summary kind="resources" part={user.resources} />
                      {adapter.has(PERMISSION.resources) ? (
                        <Button variant="outline" size="sm" onClick={() => onQueryChange({ section: 'resources' })}>
                          查看名下游戏账号
                        </Button>
                      ) : (
                        <Denied permission={PERMISSION.resources} />
                      )}
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1">成长与礼遇</span>
                      <MembershipSummaryCell summary={user.membershipSummary} />
                      {(adapter.has(PERMISSION.growthSummary) || adapter.has(PERMISSION.growthDetail) || adapter.snapshot.security.isBoss) ? (
                        <Button variant="outline" size="sm" onClick={() => onQueryChange({ section: 'growth' })}>
                          查看成长与礼遇
                        </Button>
                      ) : (
                        <Denied permission={PERMISSION.growthSummary} />
                      )}
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground block mb-1">信用状态</span>
                      <CreditSummaryCell summary={user.creditSummary} />
                      {adapter.has(PERMISSION.credit) ? (
                        <Button variant="outline" size="sm" onClick={() => onQueryChange({ section: 'credit' })}>
                          查看信用与保证金
                        </Button>
                      ) : (
                        <Denied permission={PERMISSION.credit} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="ud-overview-row">
                <h2>资金账户</h2>
                <div className="flex items-center gap-3">
                  {adapter.has(PERMISSION.finance) || adapter.snapshot.security.isBoss ? (
                    <Button variant="outline" onClick={() => onQueryChange({ section: 'finance' })}>
                      查看用户资金
                    </Button>
                  ) : (
                    <Denied permission={PERMISSION.finance} />
                  )}
                </div>
              </div>
              <div className="ud-overview-row">
                <h2>客服上下文</h2>
                {adapter.has(PERMISSION.support) ? (
                  <>
                    <Message title="用户维度完整咨询历史暂未接入">
                      客服工作台按指派与队列处理；进入工作台后重新核对权限，群访问还需已加入该订单群。
                    </Message>
                    <Button variant="outline" onClick={() => onOpenPath('/support')}>
                      进入客服工作台<ArrowUpRightIcon size={14} />
                    </Button>
                  </>
                ) : (
                  <Denied permission={PERMISSION.support} />
                )}
              </div>
              <Message title="数据完整性说明">
                订单和资源仅反映各自授权游戏范围。无权限、读取失败或暂未接入均不代表没有业务；请分别核对有权读取的订单和资源记录。
              </Message>
            </>
          ) : view === 'orders' ? (
            <Orders
              adapter={adapter}
              user={user}
              tab={tab}
              refreshNonce={refreshNonce}
              onOpenPath={onOpenPath}
              onQueryChange={onQueryChange}
            />
          ) : view === 'resources' ? (
            <Resources
              adapter={adapter}
              user={user}
              tab={tab}
              refreshNonce={refreshNonce}
              onOpenPath={onOpenPath}
              onQueryChange={onQueryChange}
            />
          ) : view === 'growth' ? (
            <MembershipGrowthSection
              adapter={adapter}
              user={user}
              refreshNonce={refreshNonce}
              onOpenPath={onOpenPath}
            />
          ) : view === 'credit' ? (
            <CreditPanel
              adapter={adapter}
              user={user}
              refreshNonce={refreshNonce}
            />
          ) : view === 'finance' ? (
            <UserFinanceSection
              adapter={adapter}
              user={user}
              refreshNonce={refreshNonce}
              onOpenPath={onOpenPath}
            />
          ) : (
            <>
              <div className="ud-overview-row">
                <h2>账号与安全状态</h2>
                <p>账号：{STATUS_LABEL[user.status]} · 实名：{user.identity} · 年龄：{user.age}</p>
                <p>{user.phoneMasked} · {user.emailMasked ?? '未绑定真实邮箱'}</p>
              </div>
              <Restore adapter={adapter} user={user} changed={() => setRevision(value => value + 1)} />
              <div className="ud-overview-row">
                <h2>账号安全操作审计</h2>
                <p className="ud-muted">当前记录已按审计权限筛选。</p>
                <DomainBlock adapter={adapter} id={id} domain="audit" refreshNonce={revision + refreshNonce}>
                  {data => (data as Audit[]).length ? (
                    <ul className="ud-audit">
                      {(data as Audit[]).map(event => (
                        <li key={event.eventId}>
                          {auditActionLabel(event.action)} · {time(event.occurredAt)} · {event.outcome === 'SUCCESS' ? '成功' : event.outcome === 'FAILURE' ? '失败' : '结果未知'}
                          <details>
                            <summary>技术标识</summary>
                            <code>{event.action} · {event.outcome} · {event.requestId ?? '无请求编号'}</code>
                          </details>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Message kind="empty" title="范围内暂无账号安全操作记录">
                      不代表其他管理员没有执行过操作。
                    </Message>
                  )}
                </DomainBlock>
              </div>
              {adapter.has(PERMISSION.audit) ? (
                <details className="ud-trace">
                  <summary>技术追溯 · 仅授权审计</summary>
                  <p>来源：{sourceLabel(user.provider)}</p>
                  {user.trace?.sourceCreatedAt ? (
                    <p>旧来源注册时间：{time(user.trace.sourceCreatedAt)}；旧来源更新时间：{time(user.trace.sourceUpdatedAt ?? null)}</p>
                  ) : (
                    <p>旧来源时间：未知或未提供。</p>
                  )}
                  {user.legacyId ? <p>旧平台ID：{user.legacyId}</p> : null}
                  <p>本地创建：{time(user.createdAt)}；本地更新：{time(user.updatedAt)}</p>
                </details>
              ) : null}
            </>
          )}
        </div>
      ))}
    </section>
  );
}
