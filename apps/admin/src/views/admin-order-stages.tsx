import { CreditCard, FileText, Flag, KeyRound, X } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { BEIJING_TIME_ZONE } from '../workspace/beijing-time';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';

const orderTime = (value: string | null | undefined) => !value || !Number.isFinite(Date.parse(value)) ? "时间未记录" : new Intl.DateTimeFormat("zh-CN", { timeZone: BEIJING_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export interface OrderStagesPayment {
  state: 'RECORDED_PAID' | 'RECORDED_UNPAID' | 'UNKNOWN' | string;
  recordedAt?: string | null;
}

export interface OrderStagesSource {
  origin?: 'NATIVE' | 'LEGACY' | string;
  statusLabel?: string;
}

export type OrderProgress = {
  asOfUtc: string | null;
  opening: { state: 'NOT_STARTED' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'NOT_APPLICABLE' | 'UNKNOWN'; confirmedAtUtc: string | null };
  ending: { state: 'NOT_STARTED' | 'PENDING_CLASSIFICATION' | 'PENDING_PARTIES' | 'PENDING_SUPPORT_REVIEW' | 'PENDING_APPROVAL' | 'READY' | 'POSTED' | 'NOT_APPLICABLE' | 'UNKNOWN'; currentVersionNo: number | null; postedAtUtc: string | null };
};

export interface OrderStagesInput {
  status: string;
  createdAt?: string | null;
  payment?: OrderStagesPayment | null;
  source?: OrderStagesSource | null;
  cancelledAt?: string | null;
  paidAt?: string | null;
  completedAt?: string | null;
  cancelReason?: string | null;
  progress?: OrderProgress | null;
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  UNKNOWN: '源状态未记录',
};

export const CANCEL_ACTOR_MAP: Record<string, string> = {
  USER: '用户取消',
  BUYER: '买家取消',
  RENTER: '租客取消',
  OWNER: '号主取消',
  SYSTEM: '超时未付系统取消',
  TIMEOUT: '超时自动取消',
  SUPPORT_UNPAID: '客服取消待付款订单',
  OWNER_DELISTED: '号主下架账号，关闭待付款订单',
  OPERATOR: '平台管理员取消',
  ADMIN: '平台管理员取消',
  RISK: '风控拦截取消',
};

export const OPENING_STATE_LABELS: Record<OrderProgress['opening']['state'], string> = {
  CONFIRMED: '已开租',
  AWAITING_CONFIRMATION: '待期初确认',
  NOT_STARTED: '未开租',
  NOT_APPLICABLE: '开租不适用',
  UNKNOWN: '开租未记录',
};

export const ENDING_STATE_LABELS: Record<OrderProgress['ending']['state'], string> = {
  POSTED: '已过账',
  PENDING_CLASSIFICATION: '待结束分类',
  PENDING_PARTIES: '待双方确认',
  PENDING_SUPPORT_REVIEW: '待客服复核',
  PENDING_APPROVAL: '待批准',
  READY: '待过账',
  NOT_STARTED: '未进入结算',
  NOT_APPLICABLE: '结算不适用',
  UNKNOWN: '结束未记录',
};

export function cancelReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  return CANCEL_ACTOR_MAP[reason] || reason;
}

export function orderPaymentLabel(payment?: OrderStagesPayment | null, origin?: string): string {
  if (!payment) return '支付事实未记录';
  if (payment.state === 'RECORDED_PAID') return '支付已记录';
  if (payment.state === 'RECORDED_UNPAID') return origin === 'LEGACY' ? '原系统记录未付，渠道结果另核' : '本站尚未确认付款';
  return '支付事实未记录';
}

function stageTone(state: string): 'done' | 'unknown' | 'none' | 'cancel' | 'active' {
  if (state === 'CONFIRMED' || state === 'POSTED') return 'done';
  if (state === 'AWAITING_CONFIRMATION' || state === 'PENDING_CLASSIFICATION' || state === 'PENDING_PARTIES' || state === 'PENDING_SUPPORT_REVIEW' || state === 'PENDING_APPROVAL' || state === 'READY') return 'active';
  if (state === 'NOT_APPLICABLE') return 'cancel';
  if (state === 'NOT_STARTED') return 'none';
  return 'unknown';
}

/**
 * 订单进度（Stages）：
 * - NATIVE progress 只来自服务端同单 opening/intake/version/posting 事实；
 * - 没有 progress 的旧调用（用户详情）保留未知，不默认已开租/已完成；
 * - LEGACY 使用原 source.statusLabel，不套 NATIVE 流程。
 */
export function OrderStages({
  order: o,
  rentalStarted,
  progress,
  variant = 'detail',
  className,
  showTimes = false,
}: {
  order: OrderStagesInput;
  rentalStarted?: unknown;
  progress?: OrderProgress | null;
  variant?: 'compact' | 'detail';
  className?: string;
  showTimes?: boolean;
}) {
  const p = o.payment;
  const pState = p?.state;
  const paid = {
    name: pState === 'UNKNOWN' || !pState ? '支付未记录' : pState === 'RECORDED_UNPAID' ? '未支付' : '支付',
    Icon: CreditCard,
    state: pState === 'RECORDED_PAID' ? 'done' : pState === 'UNKNOWN' || !pState ? 'unknown' : 'none',
    time: pState === 'RECORDED_PAID' ? (p?.recordedAt ?? o.paidAt ?? null) : null,
  };
  const legacy = o.source?.origin === 'LEGACY';
  const opening = progress ? progress.opening.state : rentalStarted === true ? 'CONFIRMED' : rentalStarted === false ? 'NOT_STARTED' : null;
  const ending = progress?.ending.state ?? null;
  const facts = o.status === 'CANCELLED'
    ? [
        { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown', time: o.createdAt },
        paid,
        { name: '取消', Icon: X, state: 'cancel', time: o.cancelledAt ?? null },
      ]
    : legacy && !progress
      ? [
          { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown', time: o.createdAt },
          paid,
          { name: o.source?.statusLabel || ORDER_STATUS_LABELS[o.status] || '原来源阶段未记录', Icon: Flag, state: o.status === 'COMPLETED' ? (o.completedAt ? 'done' : 'unknown') : o.status === 'UNKNOWN' ? 'unknown' : 'active', time: o.status === 'COMPLETED' ? (o.completedAt ?? null) : null },
        ]
      : [
          { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown', time: o.createdAt },
          paid,
          {
            name: opening ? OPENING_STATE_LABELS[opening] : '开租未记录',
            Icon: KeyRound,
            state: stageTone(opening ?? 'UNKNOWN'),
            time: progress?.opening.confirmedAtUtc ?? null,
          },
          {
            name: ending ? ENDING_STATE_LABELS[ending] : o.status === 'COMPLETED' ? '已完成' : '完成',
            Icon: Flag,
            // 无过账/完成时间证据的节点不显示为已完成
            state: ending ? stageTone(ending) : o.status === 'COMPLETED' ? (o.completedAt ? 'done' : 'unknown') : 'none',
            time: progress?.ending.postedAtUtc ?? (o.status === 'COMPLETED' ? o.completedAt ?? null : null),
          },
        ];

  const sourceLabel = legacy ? `${o.source?.statusLabel ?? '历史状态未记录'} · ` : '';
  const paymentText = orderPaymentLabel(p, o.source?.origin);
  const refundText = o.status === 'CANCELLED' && pState === 'RECORDED_PAID' ? ' · 退款进度另行查看' : '';
  const cancelText = o.status === 'CANCELLED' && o.cancelReason ? ` · ${cancelReasonText(o.cancelReason)}` : '';
  const cancellationDetail = o.status === 'CANCELLED' && progress ? `${OPENING_STATE_LABELS[progress.opening.state]} · ${ENDING_STATE_LABELS[progress.ending.state]}` : '';
  const detailSummary = showTimes
    ? [cancellationDetail, refundText.replace(/^ · /, ''), cancelText.replace(/^ · /, '')].filter(Boolean).join(' · ')
    : `${sourceLabel}${cancellationDetail ? `${cancellationDetail} · ` : ''}${paymentText}${refundText}${cancelText}${progress?.ending.postedAtUtc ? ` · 过账时间 ${orderTime(progress.ending.postedAtUtc)}` : ''}${progress?.opening.confirmedAtUtc ? ` · 开租时间 ${orderTime(progress.opening.confirmedAtUtc)}` : ''}`;
  const compactText = o.status === 'CANCELLED' ? null : progress
    ? `${OPENING_STATE_LABELS[progress.opening.state]} · ${ENDING_STATE_LABELS[progress.ending.state]}`
    : legacy
      ? o.source?.statusLabel ?? ORDER_STATUS_LABELS[o.status] ?? '原来源阶段未记录'
      : o.status === 'COMPLETED' ? '开租未记录 · 已完成' : '开租未记录';

  if (variant === 'compact') {
    // 列表和详情展示同一组事实，不能把已发生的开租节点隐藏。
    return <TooltipProvider delay={150}><div className={`oc-stages oc-stages-compact ${className ?? ''}`.trim()}>
      <div className="oc-compact-meta"><strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态未记录'}</strong>{/* 列表禁止噪音文案：紧凑说明不显示退款未记录等未记录提示，详情保留 */}<small>{compactText ? `${compactText} · ` : ''}{paymentText}{cancelText}</small></div>
      <ol aria-label="订单进度">
        {facts.map((f, i) => {
          return <li key={f.name} className={f.state}>
            <StageNode fact={f} size={12} />
            {i < facts.length - 1 ? <span className="oc-stage-line" /> : null}
          </li>;
        })}
      </ol>
    </div></TooltipProvider>;
  }

  return (
    <TooltipProvider delay={150}><div className={`oc-stages ${className ?? ''}`.trim()}>
      <strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态未记录'}</strong>
      <ol aria-label="订单进度">
        {facts.map((f, i) => (
          <li key={f.name} className={f.state}>
            <StageNode fact={f} size={13} showTime={showTimes} />
            {i < facts.length - 1 ? <span className="oc-stage-line" /> : null}
          </li>
        ))}
      </ol>
      {detailSummary ? <small>{detailSummary}</small> : null}
    </div></TooltipProvider>
  );
}

type StageFact = { name: string; Icon: ComponentType<{ size?: number }>; state: string; time?: string | null };
const stageStateText: Record<string, string> = { done: '已完成', active: '进行中', cancel: '已终止', none: '未发生', unknown: '未记录' };
/** 单个进度节点：悬停/聚焦显示北京时间；触屏点按打开。 */
function StageNode({ fact: f, size, showTime = false }: { fact: StageFact; size: number; showTime?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = `${f.name}：${f.state === 'none' ? '未发生' : orderTime(f.time)}`;
  return <><Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger render={<button type="button" className="oc-stage-trigger" aria-label={`${label}（北京时间）`} onClick={() => setOpen(true)} />}>
      <span className="oc-stage-node"><f.Icon size={size} /></span>
      <span className="oc-stage-name">{f.name}</span>
    </TooltipTrigger>
    <TooltipContent>
      <div className="grid gap-0.5">
        <span>{f.name} · {stageStateText[f.state] ?? '未记录'} · {f.state === 'none' ? '未发生' : orderTime(f.time)}</span>
        <span className="opacity-70">北京时间</span>
      </div>
    </TooltipContent>
  </Tooltip>{showTime ? <span className="oc-stage-time">{f.state === 'none' ? '未发生' : f.state === 'active' && !f.time ? f.name === '进行中' ? '履约中' : '待处理' : orderTime(f.time)}</span> : null}</>;
}
