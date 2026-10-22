import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Gamepad2 } from 'lucide-react';
import { PreviewCardShell, PreviewCopyButton, PreviewFooterAction } from './preview-card';

export interface AccountPreviewProps {
  accountId?: string;
  displayNo?: string | null;
  title?: string | null;
  gameName?: string | null;
  tag?: string;
  haffText?: string | null;
  materialsText?: string | null;
  termText?: string | null;
  loginMethodText?: string | null;
  sourceText?: string | null;
  facts?: {
    ownerPaused?: boolean;
    staffRestricted?: boolean;
    lifecycle?: string;
    reviewState?: string;
  } | null;
  canOpen?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  deniedReason?: string;
}

/**
 * 游戏账号基础预览卡片：只吃当前行已确知的编号、游戏、关联标签和安全限制事实。
 * 绝不推断可租、绝不抓取皮肤图或拼凑未提供的报价。
 */
export function AccountPreviewCard({
  accountId,
  displayNo,
  title,
  gameName,
  tag,
  haffText,
  materialsText,
  termText,
  loginMethodText,
  sourceText,
  facts,
  canOpen,
  onOpen,
  openLabel = '查看账号详情',
  deniedReason = '无查看权限',
}: AccountPreviewProps) {
  const numberText = displayNo?.trim() || '账号编号待核';

  const header = (
    <>
      <div className="size-9 rounded-lg border border-border bg-muted/40 flex items-center justify-center shrink-0 text-muted-foreground">
        <Gamepad2 className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-semibold text-sm font-mono text-foreground truncate" title={numberText}>
            {numberText}
          </span>
          {tag && (
            <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 py-0 font-normal shrink-0">
              {tag}
            </Badge>
          )}
        </div>
        {(displayNo || accountId) && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
            <PreviewCopyButton value={displayNo || accountId || ''} tooltip={displayNo ? '复制账号编号' : '复制账号 ID'} />
          </div>
        )}
      </div>
    </>
  );

  return (
    <PreviewCardShell
      ariaLabel={`账号预览：${numberText}`}
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
      {gameName && (
        <div className="text-[11px] text-foreground font-medium truncate">
          游戏：{gameName}
        </div>
      )}

      {title && (
        <div className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed" title={title}>
          {title}
        </div>
      )}

      {(haffText || materialsText) && (
        <div className="flex items-center gap-2 text-[11px] text-foreground font-medium">
          {haffText && <span>哈夫币：{haffText}</span>}
          {haffText && materialsText && <span aria-hidden="true" className="text-muted-foreground">·</span>}
          {materialsText && <span>{materialsText}</span>}
        </div>
      )}

      {(termText || loginMethodText) && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {termText && <span>租期：{termText}</span>}
          {termText && loginMethodText && <span aria-hidden="true">·</span>}
          {loginMethodText && <span>登录：{loginMethodText}</span>}
        </div>
      )}

      {sourceText && (
        <div className="text-[10px] text-muted-foreground font-mono">
          资料来源：{sourceText}
        </div>
      )}

      {facts && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {facts.staffRestricted && (
            <Badge variant="destructive" className="text-[10px] h-4 px-1 py-0">
              平台限制
            </Badge>
          )}
          {facts.ownerPaused && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 py-0 text-amber-500 border-amber-500/30">
              号主暂停
            </Badge>
          )}
          {facts.lifecycle === 'ARCHIVED' && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 py-0">
              已归档
            </Badge>
          )}
          {facts.reviewState && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 py-0">
              {({APPROVED:'审核通过',PENDING:'待审核',REJECTED:'已驳回',DRAFT:'草稿'} as Record<string,string>)[facts.reviewState] ?? '审核状态待核'}
            </Badge>
          )}
        </div>
      )}
    </PreviewCardShell>
  );
}
