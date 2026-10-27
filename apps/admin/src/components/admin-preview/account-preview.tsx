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
  safeBoxText?: string | null;
  rankText?: string | null;
  depositText?: string | null;
  depositLabel?: string;
  sourceText?: string | null;
  /** 旧平台迁入账号：照常展示 ZZ 账号编号，仅加“旧平台迁入”小标记 */
  legacy?: boolean;
  /** 价格块（置于基础信息之前）；值由调用方给出，未知须写明，不得补 0 */
  priceTitle?: string;
  priceRows?: Array<[string, string]> | null;
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
  safeBoxText,
  rankText,
  depositText,
  depositLabel = '租客基础押金',
  sourceText,
  legacy = false,
  priceTitle = '价格',
  priceRows,
  facts,
  canOpen,
  onOpen,
  openLabel = '查看账号详情',
  deniedReason = '无查看权限',
}: AccountPreviewProps) {
  const numberText = displayNo?.trim() || '账号编号待核';
  const provenance = sourceText?.trim();
  const showProvenance = provenance && !['新平台订单', '旧平台订单'].includes(provenance);
  // 基础信息顺序：上号方式、安全箱优先
  const conditions = [['上号方式', loginMethodText], ['安全箱', safeBoxText], ['租期', termText], ['段位', rankText]];

  const header = (
    <>
      <div className="size-9 rounded-lg border border-border bg-muted/40 flex items-center justify-center shrink-0 text-muted-foreground">
        <Gamepad2 className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-semibold text-sm font-mono text-foreground break-all" title={numberText}>
            {numberText}
          </span>
          {(displayNo || accountId) && <PreviewCopyButton value={displayNo || accountId || ''} tooltip={displayNo ? '复制账号编号' : '复制账号 ID'} />}
          {legacy && <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 py-0 font-normal shrink-0">旧平台迁入</Badge>}
          {tag && (
            <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 py-0 font-normal shrink-0">
              {tag}
            </Badge>
          )}
        </div>
        {gameName && <p className="text-xs text-muted-foreground">{gameName}</p>}
      </div>
    </>
  );

  return (
    <PreviewCardShell
      ariaLabel={`账号预览：${numberText}`}
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
      {title && (
        <div className="text-sm text-foreground line-clamp-2 leading-relaxed break-words" title={title}>
          {title}
        </div>
      )}

      {priceRows && priceRows.length > 0 && <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
        <p className="text-[11px] text-muted-foreground mb-1">{priceTitle}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {priceRows.map(([label, value]) => <div key={label} className="min-w-0 flex items-baseline justify-between gap-2"><dt className="text-muted-foreground shrink-0">{label}</dt><dd className="font-medium text-foreground tabular-nums text-right break-words">{value}</dd></div>)}
        </dl>
      </div>}

      {(haffText || materialsText) && <div className="space-y-1.5 py-1 text-sm leading-relaxed">
        {haffText && <p className="font-medium text-foreground tabular-nums">哈夫币：{haffText}</p>}
        {materialsText && <p className="text-foreground break-words"><span className="text-muted-foreground">物资：</span>{materialsText}</p>}
      </div>}

      {conditions.some(([, value]) => value) && <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-2 text-xs">
        {conditions.filter(([, value]) => value).map(([label, value]) => <div key={label} className="min-w-0">
          <dt className="text-muted-foreground">{label}：</dt><dd className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</dd>
        </div>)}
      </dl>}

      {depositText && <p className="flex items-baseline justify-between gap-3 border-t border-border pt-2 text-xs">
        <span>{depositLabel}</span><span className="font-medium text-foreground tabular-nums">{depositText}</span>
      </p>}

      {showProvenance && <p className="text-xs leading-relaxed text-muted-foreground">资料来源：{provenance}</p>}

      {facts && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
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
