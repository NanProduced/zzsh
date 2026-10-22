import * as React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Phone } from 'lucide-react';
import { PreviewCardShell, PreviewCopyButton, PreviewFooterAction } from './preview-card';

export interface UserPreviewProps {
  name: string;
  currentName?: string;
  userId?: string;
  image?: string | null;
  maskedPhone?: string | null;
  roleTag?: string;
  accountStatus?: string | null;
  realNameStatus?: string | null;
  canOpen?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  deniedReason?: string;
}

/**
 * 用户基础预览卡片：只展示调用点已有的真实受权摘要。
 * 去除 UUID 长文本噪音，保留单动作复制 ID、业务角色标签和脱敏联系方式。
 */
export function UserPreviewCard({
  name,
  currentName,
  userId,
  image,
  maskedPhone,
  roleTag,
  accountStatus,
  realNameStatus,
  canOpen,
  onOpen,
  openLabel = '查看用户资料',
  deniedReason = '无查看权限',
}: UserPreviewProps) {
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
          {roleTag && (
            <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 py-0 font-normal shrink-0">
              {roleTag}
            </Badge>
          )}
        </div>
      </div>
    </>
  );

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
      {currentName && currentName !== name ? <p>当前昵称：{currentName}</p> : null}

      {(accountStatus || realNameStatus) && (
        <div className="flex items-center gap-1.5 pt-0.5">
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
