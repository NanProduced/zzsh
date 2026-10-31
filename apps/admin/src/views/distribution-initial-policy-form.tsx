import { useState } from 'react';
import { buildInitialDistributionPolicyPayload, distributionCentsLabel, type DistributionPolicyInitialPayload } from './distribution-policy-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Draft = { enabled: boolean; renter: string; owner: string; minimumAccrualCents: string; settlementDelayDays: string; accountModes: ('ordinary' | 'custom')[]; reason: string };
/** Explicit first-version form. It never supplies a default rate and never fakes an existing head. */
export function DistributionInitialPolicyForm({ canSubmit, busy, onSubmit }: { canSubmit: boolean; busy: boolean; onSubmit: (payload: DistributionPolicyInitialPayload) => void }) {
  const [draft, setDraft] = useState<Draft>({ enabled: true, renter: '', owner: '', minimumAccrualCents: '', settlementDelayDays: '', accountModes: ['ordinary', 'custom'], reason: '' });
  let proposal: DistributionPolicyInitialPayload | null = null, error = '';
  try { proposal = buildInitialDistributionPolicyPayload(draft); } catch (reason) { error = reason instanceof Error ? reason.message : '请检查首版政策输入'; }
  return <form className="space-y-4 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); if (proposal && canSubmit && !busy) onSubmit(proposal); }}>
    <div><h2 className="font-semibold">初始化首版统一比例政策</h2><p className="mt-1 text-sm text-muted-foreground">只在尚无任何版本时可用；必须完整填写并走独立审批，不从旧等级、海报或默认比例推导。</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">推荐租客奖励比例（%）<Input aria-label="首版推荐租客奖励比例" inputMode="decimal" value={draft.renter} disabled={busy} onChange={e => setDraft({ ...draft, renter: e.target.value })} /></label>
      <label className="space-y-1 text-sm">推荐号主奖励比例（%）<Input aria-label="首版推荐号主奖励比例" inputMode="decimal" value={draft.owner} disabled={busy} onChange={e => setDraft({ ...draft, owner: e.target.value })} /></label>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">最低计提金额（分）<Input aria-label="首版最低计提分" inputMode="numeric" value={draft.minimumAccrualCents} disabled={busy} onChange={e => setDraft({ ...draft, minimumAccrualCents: e.target.value.trim() })} /></label>
      <label className="space-y-1 text-sm">结算后等待天数<Input aria-label="首版结算等待天数" inputMode="numeric" value={draft.settlementDelayDays} disabled={busy} onChange={e => setDraft({ ...draft, settlementDelayDays: e.target.value.trim() })} /></label>
    </div>
    <div className="space-y-1 text-sm"><span>起始计佣状态</span><Select value={draft.enabled ? 'true' : 'false'} disabled={busy} onValueChange={value => { if (value === 'true' || value === 'false') setDraft({ ...draft, enabled: value === 'true' }); }}>
      <SelectTrigger aria-label="首版计佣状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true">开启新计佣</SelectItem><SelectItem value="false">暂停新计佣（资格保留）</SelectItem></SelectContent></Select></div>
    <fieldset className="space-y-1 text-sm"><legend>适用租赁方式</legend>{([['ordinary', '普通租赁'], ['custom', '自定义方案']] as const).map(([mode, label]) => <label key={mode} className="mr-4 inline-flex items-center gap-2"><input type="checkbox" checked={draft.accountModes.includes(mode)} disabled={busy} onChange={event => setDraft({ ...draft, accountModes: event.target.checked ? [...draft.accountModes, mode] : draft.accountModes.filter(item => item !== mode) })} />{label}</label>)}</fieldset>
    <label className="block space-y-1 text-sm">首版原因<Textarea aria-label="首版政策原因" value={draft.reason} maxLength={500} disabled={busy} onChange={e => setDraft({ ...draft, reason: e.target.value })} /></label>
    {proposal ? <div className="rounded-lg border p-3 text-sm"><p className="font-medium">首版统一比例</p><p>租客 {proposal.config.renterPercent}% · 号主 {proposal.config.ownerPercent}% · 单笔最低 {distributionCentsLabel(proposal.config.minimumAccrualCents)} · 结算后 {proposal.config.settlementDelayDays} 天</p><p className="mt-2 text-muted-foreground">提交后仍需另一名有资格管理员审批与执行；此时未开启任何计佣。</p></div> : <p role="alert" className="text-sm text-muted-foreground">{error}</p>}
    <Button type="submit" disabled={!proposal || busy || !canSubmit}>{busy ? '正在提交…' : '提交首版审批'}</Button>
  </form>;
}
