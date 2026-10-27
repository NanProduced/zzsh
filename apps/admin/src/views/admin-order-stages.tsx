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
          { name: o.source?.statusLabel || ORDER_STATUS_LABELS[o.status] || '原来源阶段待核', Icon: Flag, state: o.status === 'COMPLETED' && o.completedAt ? 'done' : 'active', time: o.status === 'COMPLETED' ? (o.completedAt ?? null) : null },
        ]
      : [
          { name: '创建', Icon: FileText, state: o.createdAt ? 'done' : 'unknown', time: o.createdAt },
          paid,
          {
            name: opening ? OPENING_STATE_LABELS[opening] : '开租待核',
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
    return <TooltipProvider delay={150}><div className={`oc-stages oc-stages-compact ${className ?? ''}`.trim()}>
      <div className="oc-compact-meta"><strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态待核'}</strong>{/* 列表禁止噪音文案：紧凑说明不显示退款待核等待核提示，详情保留 */}<small>{compactText ? `${compactText} · ` : ''}{paymentText}{cancelText}</small></div>
      <ol aria-label="订单进度">
        {compactFacts.map((f, i) => {
          // 被折叠的中间节点并入最远节点的提示中，保证时间不丢
          const omitted = f === furthest ? facts.filter(x => !compactFacts.includes(x)) : [];
          return <li key={f.name} className={f.state}>
            <StageNode fact={f} size={12} omitted={omitted} />
            {i < compactFacts.length - 1 ? <span className="oc-stage-line" /> : null}
          </li>;
        })}
      </ol>
    </div></TooltipProvider>;
  }

  return (
    <TooltipProvider delay={150}><div className={`oc-stages ${className ?? ''}`.trim()}>
      <strong className="oc-stage-label">{ORDER_STATUS_LABELS[o.status] ?? '状态待核'}</strong>
      <ol aria-label="订单进度">
        {facts.map((f, i) => (
          <li key={f.name} className={f.state}>
            <StageNode fact={f} size={13} omitted={[]} />
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
    </div></TooltipProvider>
  );
}

type StageFact = { name: string; Icon: ComponentType<{ size?: number }>; state: string; time?: string | null };
const stageStateText: Record<string, string> = { done: '已完成', active: '进行中', cancel: '已终止', none: '未发生', unknown: '待核' };
/** 单个进度节点：悬停/聚焦显示北京时间；触屏点按打开；折叠节点的时间一并列出。 */
function StageNode({ fact: f, size, omitted }: { fact: StageFact; size: number; omitted: StageFact[] }) {
  const [open, setOpen] = useState(false);
  const line = (x: StageFact) => `${x.name}：${x.state === 'none' ? '未发生' : orderTime(x.time)}`;
  const label = [line(f), ...omitted.map(line)].join('；');
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger render={<button type="button" className="oc-stage-trigger" aria-label={`${label}（北京时间）`} onClick={() => setOpen(true)} />}>
      <span className="oc-stage-node"><f.Icon size={size} /></span>
      <span className="oc-stage-name">{f.name}</span>
    </TooltipTrigger>
    <TooltipContent>
      <div className="grid gap-0.5">
        {[f, ...omitted].map(x => <span key={x.name}>{x.name} · {stageStateText[x.state] ?? '待核'} · {x.state === 'none' ? '未发生' : orderTime(x.time)}</span>)}
        <span className="opacity-70">北京时间</span>
      </div>
    </TooltipContent>
  </Tooltip>;
}
