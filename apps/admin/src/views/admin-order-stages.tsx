import { CreditCard, FileText, Flag, KeyRound, X } from 'lucide-react';
import { BEIJING_TIME_ZONE } from '../workspace/beijing-time';

const orderTime = (value: string | null | undefined) => !value || !Number.isFinite(Date.parse(value)) ? "时间未提供" : new Intl.DateTimeFormat("zh-CN", { timeZone: BEIJING_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

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
  cancelReason?: string | null;
  progress?: OrderProgress | null;
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
  UNKNOWN: '源状态待核',
};

export const CANCEL_ACTOR_MAP: Record<string, string> = {
  USER: '用户取消',
  BUYER: '买家取消',
  RENTER: '租客取消',
  OWNER: '号主取消',
  SYSTEM: '超时未付系统取消',
  TIMEOUT: '超时自动取消',
  OPERATOR: '平台管理员取消',
  ADMIN: '平台管理员取消',
  RISK: '风控拦截取消',
};

export const OPENING_STATE_LABELS: Record<OrderProgress['opening']['state'], string> = {
  CONFIRMED: '已开租',
  AWAITING_CONFIRMATION: '待期初确认',
  NOT_STARTED: '未开租',
  NOT_APPLICABLE: '开租不适用',
  UNKNOWN: '开租待核',
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
  UNKNOWN: '结束待核',
};

export function cancelReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  return CANCEL_ACTOR_MAP[reason] || reason;
}

export function orderPaymentLabel(payment?: OrderStagesPayment | null): string {
  if (!payment) return '支付事实待核';
  if (payment.state === 'RECORDED_PAID') return '支付已记录';
  if (payment.state === 'RECORDED_UNPAID') return '未支付';
  return '支付事实待核';
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
}: {
  order: OrderStagesInput;
  rentalStarted?: unknown;
  progress?: OrderProgress | null;
  variant?: 'compact' | 'detail';
  className?: string;
}) {
  const p = o.payment;
  const pState = p?.state;
  const paid = {
    name: pState === 'UNKNOWN' || !pState ? '支付待核' : pState === 'RECORDED_UNPAID' ? '未支付' : '支付',
    Icon: CreditCard,
    state: pState === 'RECORDED_PAID' ? 'done' : pState === 'UNKNOWN' || !pState ? 'unknown' : 'none',
  };
  const legacy = o.source?.origin === 'LEGACY';
  const opening = progress ? progress.opening.state : rentalStarted === true ? 'CONFIRMED' : rentalStarted === false ? 'NOT_STARTED' : null;
  const ending = progress?.ending.state ?? null;
  const facts = o.status === 'CANCELLED'
    ? [
        { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown' },
        paid,
        { name: '取消', Icon: X, state: 'cancel' },
      ]
    : legacy && !progress
      ? [
          { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown' },
          paid,
          { name: o.source?.statusLabel || ORDER_STATUS_LABELS[o.status] || '原来源阶段待核', Icon: Flag, state: 'active' },
        ]
      : [
          { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown' },
          paid,
          {
            name: opening ? OPENING_STATE_LABELS[opening] : '开租待核',
            Icon: KeyRound,
            state: stageTone(opening ?? 'UNKNOWN'),
          },
          {
            name: ending ? ENDING_STATE_LABELS[ending] : o.status === 'COMPLETED' ? '已完成' : '完成',
            Icon: Flag,
            state: ending ? stageTone(ending) : o.status === 'COMPLETED' ? 'done' : 'none',
          },
        ];

  const sourceLabel = legacy ? `${o.source?.statusLabel ?? '历史状态待核'} · ` : '';
  const paymentText = orderPaymentLabel(p);
  const refundText = o.status === 'CANCELLED' && pState === 'RECORDED_PAID' ? ' · 退款待核' : '';
  const cancelText = o.status === 'CANCELLED' && o.cancelReason ? ` · ${cancelReasonText(o.cancelReason)}` : '';
  const compactText = o.status === 'CANCELLED' ? null : progress
    ? `${OPENING_STATE_LABELS[progress.opening.state]} · ${ENDING_STATE_LABELS[progress.ending.state]}`
    : legacy
      ? o.source?.statusLabel ?? ORDER_STATUS_LABELS[o.status] ?? '原来源阶段待核'
      : o.status === 'COMPLETED' ? '开租待核 · 已完成' : '开租待核';

  if (variant === 'compact') {
    // 列表只保留关键阶段：创建、支付与最远已发生/待处理节点；完整节点留在详情。
    const furthest = [...facts].reverse().find(f => f.state !== 'none') ?? facts[facts.length - 1];
    const compactFacts = facts.length > 3 ? [facts[0]!, facts[1]!, furthest!].filter((f, index, all) => all.indexOf(f) === index) : facts;
    return <div className={`oc-stages oc-stages-compact ${className ?? ''}`.trim()}>
      <div className="oc-compact-meta"><strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态待核'}</strong><small>{compactText ? `${compactText} · ` : ''}{paymentText}{refundText}{cancelText}</small></div>
      <ol aria-label="订单进度">
        {compactFacts.map((f, i) => (
          <li key={f.name} className={f.state}>
            <span className="oc-stage-node"><f.Icon size={12} /></span>
            <span className="oc-stage-name">{f.name}</span>
            {i < compactFacts.length - 1 ? <span className="oc-stage-line" /> : null}
          </li>
        ))}
      </ol>
    </div>;
  }

  return (
    <div className={`oc-stages ${className ?? ''}`.trim()}>
      <strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态待核'}</strong>
      <ol aria-label="订单进度">
        {facts.map((f, i) => (
          <li key={f.name} className={f.state}>
            <span className="oc-stage-node">
              <f.Icon size={13} />
            </span>
            <span className="oc-stage-name">{f.name}</span>
            {i < facts.length - 1 ? <span className="oc-stage-line" /> : null}
          </li>
        ))}
      </ol>
      <small>
        {sourceLabel}
        {o.status === 'CANCELLED' && progress ? `${OPENING_STATE_LABELS[progress.opening.state]} · ${ENDING_STATE_LABELS[progress.ending.state]} · ` : ''}
        {paymentText}
        {refundText}
        {cancelText}
        {progress?.ending.postedAtUtc ? ` · 过账时间 ${orderTime(progress.ending.postedAtUtc)}` : ''}
        {progress?.opening.confirmedAtUtc ? ` · 开租时间 ${orderTime(progress.opening.confirmedAtUtc)}` : ''}
      </small>
    </div>
  );
}
