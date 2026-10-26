import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Phone } from 'lucide-react';
import { PreviewCardShell, PreviewCopyButton, PreviewFooterAction } from './preview-card';
import type { DirectoryUserPreview } from '@/api';
import { BEIJING_TIME_ZONE } from '@/workspace/beijing-time';

export interface UserPreviewProps {
  name: string;
  currentName?: string;
  userId?: string;
  businessNo?: string | null;
  lastLoginAt?: string | null;
  image?: string | null;
  maskedPhone?: string | null;
  accountStatus?: string | null;
  realNameStatus?: string | null;
  membershipTier?: string | null;
  creditScore?: number | null;
  creditState?: 'KNOWN' | 'NOT_INITIALIZED' | 'DENIED' | 'OUT_OF_SCOPE' | string | null;
  riskFlag?: boolean | null;
  membershipSummary?: DirectoryUserPreview['membershipSummary'];
  creditSummary?: DirectoryUserPreview['creditSummary'];
  canOpen?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  deniedReason?: string;
}

type UserPreviewSummary = DirectoryUserPreview & Pick<UserPreviewProps, 'businessNo' | 'lastLoginAt' | 'accountStatus' | 'realNameStatus'>;
const loginFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: BEIJING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function loginTime(value: string | null | undefined): string | null {
  if (!value || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return loginFormatter.format(new Date(value));
}

export function hasUsefulUserPreview(summary: UserPreviewSummary | null | undefined, rowName: string): boolean {
  return !!(summary?.image?.trim() || summary?.maskedPhone?.trim() || summary?.name?.trim() && summary.name.trim() !== rowName.trim()
    || summary?.membershipSummary?.state==='ready' || summary?.creditSummary?.state==='ready' || summary?.riskFlag===true
    || summary?.businessNo?.trim() || summary?.accountStatus?.trim() || summary?.realNameStatus?.trim() || loginTime(summary?.lastLoginAt));
}

/**
 * 用户基础预览卡片：只展示调用点已有的真实受权摘要。
 * 去除 UUID 长文本噪音，保留单动作复制 ID 和脱敏联系方式。
 * 补充会员等级、信用分与内部高危标识；已知值才显示，未标记不称“安全”。
 */
export function UserPreviewCard({
  name,
  currentName,
  userId,
  businessNo,
  lastLoginAt,
  image,
  maskedPhone,
  accountStatus,
  realNameStatus,
  membershipTier,
  creditScore,
  creditState,
  riskFlag,
  membershipSummary,
  creditSummary,
  canOpen,
  onOpen,
  openLabel = '查看用户资料',
  deniedReason = '无查看权限',
}: UserPreviewProps) {
  const tiers: Record<string,string> = {STANDARD:'普通会员',SILVER:'银卡',GOLD:'金卡',PLATINUM:'铂金',DIAMOND:'钻石',BLACK_GOLD:'黑金（永久）'};
  const membershipText = membershipSummary
    ? membershipSummary.state === 'denied' ? '无权限'
      : membershipSummary.growth.knowledge === 'KNOWN' ? tiers[membershipSummary.growth.effectiveTier ?? ''] ?? '等级待核' : '等级待核'
    : membershipTier ? tiers[membershipTier] ?? membershipTier : null;
  // Summary knowledge is authoritative; denied/unknown never falls back to an old scalar score.
  const knowledge = creditSummary ? creditSummary.state === 'denied' ? 'DENIED' : creditSummary.knowledge : creditState;
  const score = creditSummary ? creditSummary.state === 'ready' ? creditSummary.score : null : creditScore;
  const validScore = typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100;
  const creditText = knowledge === 'DENIED' || knowledge === 'OUT_OF_SCOPE' ? '无权限'
    : knowledge === 'NOT_INITIALIZED' ? '未初始化'
    : (knowledge === 'KNOWN' || knowledge === undefined) && validScore ? String(score)
    : knowledge !== undefined || score !== undefined && score !== null ? '待核实' : null;
  const lastLoginText = loginTime(lastLoginAt);
  const facts = [['会员', membershipText], ['信用分', creditText], ['账号状态', accountStatus], ['实名状态', realNameStatus]];
  const initial = name.trim().slice(0, 1) || '用';

  const header = (
    <>
      <Avatar size="default" className="size-9 border border-border shrink-0">
        {image ? <AvatarImage src={image} alt="" /> : null}
        <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
          {initial}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-semibold text-sm text-foreground truncate" title={name}>
            {name}
          </span>
          {businessNo || userId ? <PreviewCopyButton value={businessNo || userId || ''} tooltip={businessNo ? '复制用户编号' : '复制用户 ID'} /> : null}
        </div>
        {businessNo && <p className="text-xs text-muted-foreground font-mono break-all">编号 {businessNo}</p>}
      </div>
    </>
  );

  return (
    <PreviewCardShell
      ariaLabel={`用户预览：${name}`}
      className="w-80"
      header={header}
      footer={
        <PreviewFooterAction
          canOpen={canOpen}
          onOpen={onOpen}
          label={openLabel}
          deniedReason={deniedReason}
        />
      }
    >
      {maskedPhone ? (
        <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
          <Phone className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
          <span>{maskedPhone}</span>
        </div>
      ) : null}
      {currentName && currentName !== name ? (
        <p className="text-xs text-muted-foreground">当前昵称：{currentName}</p>
      ) : null}

      {facts.some(([, value]) => value) && <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-2 text-xs">
        {facts.filter(([, value]) => value).map(([label, value]) => <div key={label} className="min-w-0">
          <dt className="text-muted-foreground">{label}：</dt><dd className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</dd>
        </div>)}
      </dl>}
      {lastLoginText && <p className="border-t border-border pt-2 text-xs leading-relaxed">
        <span>最后登录（北京）：</span><time dateTime={lastLoginAt ?? undefined} className="text-foreground tabular-nums">{lastLoginText}</time>
      </p>}
      {riskFlag === true && <Badge variant="destructive" className="text-xs font-medium">内部高危</Badge>}
    </PreviewCardShell>
  );
}
