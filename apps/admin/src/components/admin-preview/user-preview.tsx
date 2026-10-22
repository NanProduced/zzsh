import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Phone } from 'lucide-react';
import { PreviewCardShell, PreviewCopyButton, PreviewFooterAction } from './preview-card';
import type { DirectoryUserPreview } from '@/api';

export interface UserPreviewProps {
  name: string;
  currentName?: string;
  userId?: string;
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

export function hasUsefulUserPreview(summary: DirectoryUserPreview | null | undefined, rowName: string): boolean {
  return !!(summary?.image?.trim() || summary?.maskedPhone?.trim() || summary?.name?.trim() && summary.name.trim() !== rowName.trim()
    || summary?.membershipSummary?.state==='ready' || summary?.creditSummary?.state==='ready' || summary?.riskFlag===true);
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
  if (membershipSummary?.state==='ready') {
    const tiers: Record<string,string> = {STANDARD:'普通会员',SILVER:'银卡',GOLD:'金卡',PLATINUM:'铂金',DIAMOND:'钻石',BLACK_GOLD:'黑金'};
    membershipTier = membershipSummary.growth.knowledge==='KNOWN' ? tiers[membershipSummary.growth.effectiveTier??''] ?? '等级待核' : '等级待核';
  }
  if (creditSummary?.state==='ready') { creditState=creditSummary.knowledge; creditScore=creditSummary.score; }
  const initial = name.trim().slice(0, 1) || '用';

  const header = (
    <>
      <Avatar size="default" className="size-9 border border-border shrink-0">
        {image ? <AvatarImage src={image} alt="" /> : null}
        <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
          {initial}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-semibold text-sm text-foreground truncate" title={name}>
            {name}
          </span>
          {userId ? <PreviewCopyButton value={userId} tooltip="复制用户 ID" /> : null}
        </div>
      </div>
    </>
  );

  const hasCreditInfo = creditState || typeof creditScore === 'number';

  return (
    <PreviewCardShell
      ariaLabel={`用户预览：${name}`}
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
        <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
          <Phone className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
          <span>{maskedPhone}</span>
        </div>
      ) : null}
      {currentName && currentName !== name ? (
        <p className="text-[11px] text-muted-foreground">当前昵称：{currentName}</p>
      ) : null}

      {(membershipTier || hasCreditInfo) && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {membershipTier && <span>会员：{membershipTier}</span>}
          {membershipTier && hasCreditInfo && <span aria-hidden="true">·</span>}
          {creditState === 'KNOWN' && typeof creditScore === 'number' ? (
            <span>信用分：{creditScore}</span>
          ) : creditState === 'NOT_INITIALIZED' ? (
            <span>信用：未初始化</span>
          ) : creditState === 'DENIED' || creditState === 'OUT_OF_SCOPE' ? (
            <span>信用：无权限</span>
          ) : typeof creditScore === 'number' ? (
            <span>信用分：{creditScore}</span>
          ) : null}
        </div>
      )}

      {(accountStatus || realNameStatus || riskFlag === true) && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {riskFlag === true && (
            <Badge variant="destructive" className="text-[10px] h-4 px-1 py-0 font-medium">
              高危
            </Badge>
          )}
          {accountStatus && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 py-0">
              {accountStatus}
            </Badge>
          )}
          {realNameStatus && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 py-0">
              {realNameStatus}
            </Badge>
          )}
        </div>
      )}
    </PreviewCardShell>
  );
}
