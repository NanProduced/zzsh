import { CreditCard, FileText, Flag, KeyRound, X } from 'lucide-react';

export interface OrderStagesPayment {
  state: 'RECORDED_PAID' | 'RECORDED_UNPAID' | 'UNKNOWN' | string;
  recordedAt?: string | null;
}

export interface OrderStagesSource {
  origin?: 'NATIVE' | 'LEGACY' | string;
  statusLabel?: string;
}

export interface OrderStagesInput {
  status: string;
  createdAt?: string | null;
  payment?: OrderStagesPayment | null;
  source?: OrderStagesSource | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
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

/**
 * 订单流程节点图形组件（Stages）：
 * 统一主订单页、详情页与用户订单表的状态机呈现。
 * UNKNOWN 不冒充已开租/已支付；保留取消退款待核逻辑；取消主体转换为中文映射。
 */
export function OrderStages({
  order: o,
  rentalStarted,
  className,
}: {
  order: OrderStagesInput;
  rentalStarted?: unknown;
  className?: string;
}) {
  const p = o.payment;
  const pState = p?.state;
  const paid = {
    name: pState === 'UNKNOWN' || !pState ? '支付待核' : pState === 'RECORDED_UNPAID' ? '未支付' : '支付',
    Icon: CreditCard,
    state: pState === 'RECORDED_PAID' ? 'done' : pState === 'UNKNOWN' || !pState ? 'unknown' : 'none',
  };
  const facts = o.status === 'CANCELLED'
    ? [
        { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown' },
        paid,
        { name: '取消', Icon: X, state: 'cancel' },
      ]
    : [
        { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown' },
        paid,
        {
          name: rentalStarted === true ? '已开租' : rentalStarted === false ? '未开租' : '开租待核',
          Icon: KeyRound,
          state: rentalStarted === true ? 'done' : rentalStarted === false ? 'none' : 'unknown',
        },
        { name: '完成', Icon: Flag, state: o.status === 'COMPLETED' ? 'done' : 'none' },
      ];

  const sourceLabel = o.source?.origin === 'LEGACY' ? `${o.source.statusLabel ?? '历史状态待核'} · ` : '';
  const paymentText = orderPaymentLabel(p);
  const refundText = o.status === 'CANCELLED' && pState === 'RECORDED_PAID' ? ' · 退款待核' : '';
  const cancelText = o.status === 'CANCELLED' && o.cancelReason ? ` · ${cancelReasonText(o.cancelReason)}` : '';

  return (
    <div className={`oc-stages ${className ?? ''}`.trim()}>
      <strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态待核'}</strong>
      <ol aria-label="已知订单事实">
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
        {paymentText}
        {refundText}
        {cancelText}
      </small>
    </div>
  );
}
