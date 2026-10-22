import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Receipt } from 'lucide-react';
import { PreviewCardShell, PreviewCopyButton, PreviewFooterAction } from './preview-card';

export interface OrderPreviewProps {
  orderId: string;
  displayNo?: string | null;
  status?: string | null;
  statusLabel?: string | null;
  renterName?: string | null;
  ownerName?: string | null;
  /** @deprecated 仅为旧调用方兼容，优先使用中性 renterName / ownerName */
  role?: 'renter' | 'owner' | null;
  /** @deprecated 仅为旧调用方兼容，优先使用中性 renterName / ownerName */
  roleLabel?: string | null;
  title?: string | null;
  counterpartyName?: string | null;
  createdAt?: string | null;
  amountText?: string | null;
  sourceOrigin?: string | null;
  canOpen?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  deniedReason?: string;
}

/**
 * 订单基础预览卡片：只吃当前行已有金额与状态事实。
 * 严禁混用应付/押金/渠道资金，缺失即留白或标示待核，支持单动作复制订单号。
 * 中性呈现租客与号主双方受权名称，去本单身份/对方主观视角。
 */
export function OrderPreviewCard({
  orderId,
  displayNo,
  status,
  statusLabel,
  renterName,
  ownerName,
  role,
  roleLabel,
  title,
  counterpartyName,
  createdAt,
  amountText,
  sourceOrigin,
  canOpen,
  onOpen,
  openLabel = '查看订单详情',
  deniedReason = '无查看权限',
}: OrderPreviewProps) {
  const numberText = displayNo || '订单编号待核';
  const isPaid = status === 'PAID' || status === 'COMPLETED';
  const isPending = status === 'PENDING_PAYMENT';

  const header = (
    <>
      <div className="size-9 rounded-lg border border-border bg-muted/40 flex items-center justify-center shrink-0 text-muted-foreground">
        <Receipt className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-semibold text-sm font-mono text-foreground truncate" title={numberText}>
            {numberText}
          </span>
          {statusLabel && (
            <Badge
              variant={isPaid ? 'secondary' : isPending ? 'outline' : 'outline'}
              className="text-[10px] h-4.5 px-1.5 py-0 font-normal shrink-0"
            >
              {statusLabel}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
          <PreviewCopyButton value={displayNo || orderId} tooltip={displayNo ? '复制订单号' : '复制订单 ID'} />
          {sourceOrigin === 'LEGACY' && (
            <Badge variant="outline" className="text-[9px] h-3.5 px-1 py-0 ml-auto">
              旧单
            </Badge>
          )}
        </div>
      </div>
    </>
  );

  return (
    <PreviewCardShell
      ariaLabel={`订单预览：${numberText}`}
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
        <div className="text-[11px] text-foreground font-medium line-clamp-1" title={title}>
          {title}
        </div>
      )}

      {(renterName || ownerName || counterpartyName) && (
        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 truncate">
          {renterName && <span>租客：{renterName}</span>}
          {renterName && ownerName && <span aria-hidden="true">·</span>}
          {ownerName && <span>号主：{ownerName}</span>}
          {!renterName && !ownerName && counterpartyName && <span>关联方：{counterpartyName}</span>}
        </div>
      )}

      {createdAt && (
        <div className="text-[11px] text-muted-foreground font-mono">
          下单时间：{createdAt}
        </div>
      )}

      {amountText && (
        <div className="text-[11px] text-foreground font-medium font-mono pt-0.5">
          {amountText}
        </div>
      )}
    </PreviewCardShell>
  );
}
