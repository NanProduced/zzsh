import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { AdminOwnerGuaranteeHistory } from '../owner-guarantee-history';
import { financeMoney } from '../admin-finance-api';
import { ListPagination } from '@/components/admin-list/list-pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { AdminApiError } from '@/api';
import { Message, creditTone, errorText, time, useDirectoryRequest, type UserDirectoryData } from './user-directory-shared';
import { PERMISSION, type User } from './user-directory-data';

const eventLabels: Record<string, string> = { INITIALIZED: '初始信用', BREACH_CONFIRMED: '确认违约', BREACH_REVERSED: '撤销误判', RECOVERY_APPROVED: '审核恢复', MANUAL_DEDUCTION: '人工扣分', MANUAL_DEDUCTION_REVERSED: '扣分更正' };
const recoveryLabels: Record<string, string> = { PENDING: '待审核', APPROVED: '已批准', REJECTED: '已拒绝' };
const guaranteeLabels: Record<string, string> = { NOT_REQUIRED: '免缴', REQUIRED: '待补保证金', PAYMENT_PENDING: '支付待确认', SATISFIED: '资格已确认', REFUND_REQUESTED: '退款待处理', REFUND_PROCESSING: '退款处理中', REFUNDED: '退款已记录', CONFIRMED: '收款已记录', ACCEPTED: '已受理', FAILED: '失败待核', UNKNOWN: '待核' };
type CreditEntry = { id: string; eventType: string; visibleReason: string; scoreBefore: number; scoreAfter: number; appliedDeltaScore: number; reversed?: boolean; createdAt: string; actorAdminId?: string | null; actorAdminName?: string | null; actorName?: string | null };
type Intent = { subject: string; path: string; body: Record<string, unknown>; key: string; generation: number; persisted: boolean; phase: 'unknown' | 'readback'; eventId?: string };
const intentMemory = new Map<string, Intent>();
const intentGenerations = new Map<string, number>();
const intentKey = (subject: string) => `zzsh.admin.credit.${encodeURIComponent(subject)}`;
const sameIntent = (a: Intent, b: Intent) => a.key === b.key && a.generation === b.generation && a.path === b.path && JSON.stringify(a.body) === JSON.stringify(b.body);

function remember(intent: Intent): boolean {
  const current = intentMemory.get(intent.subject);
  if (current?.persisted && !sameIntent(current, intent)) return false;
  try {
    sessionStorage.setItem(intentKey(intent.subject), JSON.stringify({ ...intent, persisted: true }));
    intent.persisted = true;
    intentMemory.set(intent.subject, intent);
    return true;
  } catch { return false; }
}
function restore(subject: string): Intent | null {
  const memory = intentMemory.get(subject);
  if (memory?.persisted) return memory;
  try {
    const value = JSON.parse(sessionStorage.getItem(intentKey(subject)) ?? 'null') as Intent | null;
    if (value?.persisted === true && value.subject === subject && Number.isSafeInteger(value.generation) && ['unknown', 'readback'].includes(value.phase) && typeof value.key === 'string' && typeof value.path === 'string' && value.body && typeof value.body === 'object') {
      intentMemory.set(subject, value);
      intentGenerations.set(subject, Math.max(intentGenerations.get(subject) ?? 0, value.generation));
      return value;
    }
  } catch { /* Keep unresolved operations in memory when storage is temporarily unavailable. */ }
  return null;
}
function forget(intent: Intent): boolean {
  const current = intentMemory.get(intent.subject);
  if (current && !sameIntent(current, intent)) return false;
  try {
    const stored = JSON.parse(sessionStorage.getItem(intentKey(intent.subject)) ?? 'null') as Intent | null;
    if (stored && !sameIntent(stored, intent)) return false;
    sessionStorage.removeItem(intentKey(intent.subject));
    intentMemory.delete(intent.subject);
    return true;
  } catch { return false; }
}
function accepted(intent: Intent, eventId: string): boolean {
  const current = intentMemory.get(intent.subject);
  if (!current || !sameIntent(current, intent)) return false;
  intent.phase = 'readback';
  intent.eventId = eventId;
  current.phase = 'readback';
  current.eventId = eventId;
  return remember(intent);
}
const unknownWrite = (error: unknown) => error instanceof AdminApiError && (error.status === 0 || error.status >= 500 || error.status === 401 || error.status === 423);

export function CreditPanel({ adapter, user, refreshNonce, active = true, changed }: { adapter: UserDirectoryData; user: User; refreshNonce: number; active?: boolean; changed?: () => void }) {
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<'deduct' | CreditEntry | null>(null);
  const [amount, setAmount] = useState('');
  const [explanation, setExplanation] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [eventPage, setEventPage] = useState(1);
  const [eventPageSize, setEventPageSize] = useState(20);
  const subject = `${adapter.snapshot.adminUserId}:${adapter.snapshot.session.id}:${user.id}`;
  const [pending, setPending] = useState<Intent | null>(() => restore(subject));
  const enabled = active && adapter.snapshot.security.status === 'ACTIVE' && !adapter.snapshot.security.passwordChangeRequired && !adapter.snapshot.session.locked;
  const view = useRef({ subject, enabled, mounted: true });
  view.current = { subject, enabled, mounted: view.current.mounted };
  useEffect(() => { view.current.mounted = true; return () => { view.current.mounted = false; }; }, []);
  useEffect(() => { setPending(restore(subject)); setDialog(null); setAmount(''); setExplanation(''); setNotice(''); setWorking(false); setEventPage(1); }, [subject, enabled]);
  const { result, retry } = useDirectoryRequest(`${subject}:credit:${refreshNonce}:${revision}:${enabled}`, signal => enabled ? adapter.credit(user.id, signal) : Promise.reject(new AdminApiError(403, 'FORBIDDEN')));
  const current = (intent: Intent) => view.current.mounted && view.current.enabled && view.current.subject === intent.subject;
  const guaranteeHistory = enabled && adapter.hasCreditGuaranteeRead() ? <Collapsible className="rounded-xl border bg-card"><CollapsibleTrigger render={<Button variant="ghost" className="w-full justify-between px-4" />}>保证金来源记录<ChevronDownIcon className="size-4" aria-hidden /></CollapsibleTrigger><CollapsibleContent className="p-4"><AdminOwnerGuaranteeHistory subjectUserId={user.id} adminUserId={adapter.snapshot.adminUserId} scopeKey={JSON.stringify([subject, refreshNonce, revision, [...adapter.snapshot.permissions].sort()])} canRead={true} /></CollapsibleContent></Collapsible> : null;

  if (!adapter.has(PERMISSION.credit)) return <Message kind="denied" title="信用记录无权限">当前管理员无法读取该用户的信用记录。</Message>;
  if (!enabled) return null;
  if (result.state === 'loading') return <div role="status" aria-label="正在加载信用记录" className="grid gap-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-52 w-full" /></div>;
  if (result.state === 'error') return <><Message kind="error" title="信用记录读取失败" retry={retry}>{errorText(result.error)}</Message>{guaranteeHistory}</>;
  const data = result.data;
  const credit = data.credit;
  const score = Number.isInteger(credit?.score) && credit.score >= 0 && credit.score <= 100 ? credit.score as number : null;
  const knownRevision = typeof credit?.revision === 'string' && /^[1-9]\d*$/.test(credit.revision) ? credit.revision as string : null;
  const canWrite = adapter.has(PERMISSION.creditDecide);
  const events = Array.isArray(credit?.events) ? credit.events as CreditEntry[] : [];
  const visiblePage = Math.min(eventPage, Math.max(1, Math.ceil(events.length / eventPageSize)));
  const visibleEvents = events.slice((visiblePage - 1) * eventPageSize, visiblePage * eventPageSize);
  const busy = working || pending !== null;
  const numericAmount = /^[1-9]\d{0,2}$/.test(amount) ? Number(amount) : null;
  const amountValid = numericAmount !== null && numericAmount <= 100 && score !== null && numericAmount <= score;
  const reasonValid = explanation.trim().length >= 2 && explanation.trim().length <= 500;
  const newManualPath = pending?.path.startsWith(`users/${encodeURIComponent(user.id)}/deductions`) === true;

  const readback = async (intent: Intent) => {
    if (!current(intent)) return;
    setWorking(true);
    try {
      const fresh = await adapter.credit(user.id, new AbortController().signal);
      if (intent.eventId && !fresh.credit?.events?.some((event: CreditEntry) => event.id === intent.eventId)) throw new Error('信用记录尚未更新，请稍后重新读取。');
      if (!forget(intent)) throw new Error('记录已更新，但浏览器暂时无法清除待核对标记，请恢复站点存储后重试。');
      if (current(intent)) { setPending(null); setRevision(value => value + 1); setEventPage(1); setNotice('信用记录已更新。'); changed?.(); }
    } catch (error) {
      if (current(intent)) { setPending(intent); setNotice(`操作已受理，信用记录暂未读到。${errorText(error)}`); }
    } finally { if (current(intent)) setWorking(false); }
  };
  const execute = async (intent: Intent) => {
    if (!current(intent)) return;
    const rechecking = intent.persisted;
    if (!remember(intent)) { setNotice('浏览器无法保存本次操作，尚未提交。请检查站点存储后重试。'); return; }
    setPending(intent); setWorking(true); setNotice(''); setDialog(null);
    try {
      const response = await adapter.creditDecide(intent.path, intent.body, new AbortController().signal, intent.key);
      const receipt = response.event as { id?: unknown } | undefined;
      if (typeof receipt?.id !== 'string' || !receipt.id) throw new AdminApiError(502, 'CREDIT_CONTRACT_REQUIRED');
      const persisted = accepted(intent, receipt.id);
      if (!current(intent)) return;
      setPending({ ...intent });
      if (!persisted) { setNotice('操作已受理，浏览器暂时无法保存核对状态。请保持此页打开，恢复站点存储后重新读取。'); return; }
      await readback(intent);
    } catch (error) {
      if (!current(intent)) return;
      if (unknownWrite(error) || rechecking) { setPending(intent); setNotice('操作结果暂未确认，请用原请求核对。'); }
      else { forget(intent); setPending(null); setNotice(errorText(error)); if (error instanceof AdminApiError && error.status === 409) setRevision(value => value + 1); }
    } finally { if (current(intent)) setWorking(false); }
  };
  const submit = () => {
    if (!dialog || !canWrite || !knownRevision || !reasonValid || working || (dialog === 'deduct' && !amountValid)) return;
    const unresolved = restore(subject);
    if (unresolved) { setPending(unresolved); setDialog(null); setNotice('上一笔操作尚未确认，请先核对结果。'); return; }
    const generation = (intentGenerations.get(subject) ?? 0) + 1;
    intentGenerations.set(subject, generation);
    const path = `users/${encodeURIComponent(user.id)}/deductions${dialog === 'deduct' ? '' : `/${encodeURIComponent(dialog.id)}/reverse`}`;
    const body = { expectedRevision: knownRevision, visibleReason: explanation.trim(), ...(dialog === 'deduct' ? { amount: numericAmount } : {}) };
    void execute({ subject, path, body, key: `idem_${globalThis.crypto.randomUUID().replaceAll('-', '')}`, generation, persisted: false, phase: 'unknown' });
  };
  const open = (value: 'deduct' | CreditEntry) => { setAmount(''); setExplanation(''); setDialog(value); };
  const tone = score === null ? 'unknown' : creditTone(score);
  const scoreColor = tone === 'success' ? 'text-emerald-800 dark:text-emerald-300' : tone === 'warning' ? 'text-amber-900 dark:text-amber-300' : tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground';

  return <div className="ud-credit-panel">
    {notice ? <Message title="信用操作提示">{notice}</Message> : null}
    {pending ? <Message title={pending.phase === 'readback' ? '操作已受理，等待读取记录' : '上一笔操作结果待确认'}>
      {pending.phase === 'readback' ? <Button variant="outline" size="sm" disabled={working} onClick={() => void readback(pending)}>重新读取</Button>
        : newManualPath ? <Button variant="outline" size="sm" disabled={working} onClick={() => void execute(pending)}>核对原操作</Button>
          : <span>历史操作暂不支持再次提交，请保留记录并核对原办理结果。</span>}
    </Message> : null}
    <section aria-label="当前信用分" className="rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold">当前信用分</h3>{canWrite ? <Button size="sm" disabled={busy || score === null || score === 0 || !knownRevision} onClick={() => open('deduct')}>手动扣分</Button> : null}</div>
      <div className="mt-4 flex flex-wrap items-center gap-3"><strong className={`text-4xl font-semibold tabular-nums ${scoreColor}`}>{score ?? '—'}{score !== null ? <span className="ml-1 text-sm font-normal">分</span> : null}</strong><Badge variant={tone}>{score === null ? '未评分' : score >= 80 ? '信用良好' : score >= 60 ? '需注意' : '信用较低'}</Badge></div>
      <p className="mt-3 text-sm text-muted-foreground">{score === null ? '暂未建立信用记录，不能进行扣分。' : '80 分及以上为良好，60–79 分需注意，低于 60 分信用较低。'}</p>
    </section>
    <section aria-label="信用记录" className="min-w-0 rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-4 sm:px-5"><h3 className="text-base font-semibold">信用记录</h3><span className="text-sm text-muted-foreground">说明对用户可见</span></div>
      {events.length ? <Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>变更</TableHead><TableHead>分数变化</TableHead><TableHead>用户可见说明</TableHead><TableHead>操作人</TableHead>{canWrite ? <TableHead className="text-right">操作</TableHead> : null}</TableRow></TableHeader><TableBody>{visibleEvents.map(item => <TableRow key={item.id}>
        <TableCell className="align-top text-xs text-muted-foreground">{time(item.createdAt)}</TableCell>
        <TableCell className="align-top"><span>{eventLabels[item.eventType] ?? '其他信用记录'}</span>{item.reversed ? <Badge variant="outline" className="ml-2">已更正</Badge> : null}</TableCell>
        <TableCell className="align-top tabular-nums"><span>{item.scoreBefore} → {item.scoreAfter}</span><span className={`ml-2 text-xs ${item.appliedDeltaScore < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{item.appliedDeltaScore > 0 ? '+' : ''}{item.appliedDeltaScore || '—'}</span></TableCell>
        <TableCell className="min-w-52 max-w-lg whitespace-normal align-top break-words">{item.visibleReason}</TableCell>
        <TableCell className="max-w-48 whitespace-normal align-top break-all">{item.actorAdminName || item.actorName || item.actorAdminId || (item.eventType === 'INITIALIZED' ? '系统' : '未记录')}</TableCell>
        {canWrite ? <TableCell className="text-right align-top">{item.eventType === 'MANUAL_DEDUCTION' && !item.reversed ? <Button variant="ghost" size="sm" disabled={busy || !knownRevision} onClick={() => open(item)} aria-label={`更正这笔扣分：${item.visibleReason}`}>更正</Button> : '—'}</TableCell> : null}
      </TableRow>)}</TableBody></Table> : <div className="px-4 pb-4"><Message kind="empty" title="暂无信用记录">后续信用变化会在这里保留。</Message></div>}
      {events.length ? <div className="px-4 pb-4"><ListPagination mode="page" page={visiblePage} pageSize={eventPageSize} total={events.length} loadedCount={visibleEvents.length} loading={false} pageSizeOptions={[10, 20, 50]} itemLabel="条记录" onPageChange={setEventPage} onPageSizeChange={size => { setEventPageSize(size); setEventPage(1); }} /></div> : null}
    </section>
    {data.recoveryRequests?.length ? <Collapsible className="rounded-xl border bg-card"><CollapsibleTrigger render={<Button variant="ghost" className="w-full justify-between px-4" />}>恢复申请<ChevronDownIcon className="size-4" aria-hidden /></CollapsibleTrigger><CollapsibleContent className="px-4 pb-4"><Table><TableHeader><TableRow><TableHead>申请时间</TableHead><TableHead>状态</TableHead><TableHead>说明</TableHead><TableHead>审核说明</TableHead></TableRow></TableHeader><TableBody>{data.recoveryRequests.map((item: any) => <TableRow key={item.id}><TableCell>{time(item.createdAt)}</TableCell><TableCell>{recoveryLabels[item.status] ?? '待核'}</TableCell><TableCell className="whitespace-normal">{item.reason}</TableCell><TableCell className="whitespace-normal">{item.decisionReason || '未记录'}</TableCell></TableRow>)}</TableBody></Table></CollapsibleContent></Collapsible> : null}
    {adapter.hasCreditGuaranteeRead() ? <Collapsible className="rounded-xl border bg-card"><CollapsibleTrigger render={<Button variant="ghost" className="w-full justify-between px-4" />}>号主保证金与收退记录<ChevronDownIcon className="size-4" aria-hidden /></CollapsibleTrigger><CollapsibleContent className="grid gap-4 px-4 pb-4">
      <p className="text-sm text-muted-foreground">资格、收退记录与渠道到账分别核对。</p>
      {data.guarantees?.length ? <Table><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>状态</TableHead><TableHead>应缴保证金</TableHead></TableRow></TableHeader><TableBody>{data.guarantees.map((item: any) => <TableRow key={`${item.accountId}:${item.versionId}:${item.priceVersionId}`}><TableCell>{item.displayNo || item.accountId}</TableCell><TableCell>{guaranteeLabels[item.state] ?? '待核'}</TableCell><TableCell>{financeMoney(item.requiredCents)}</TableCell></TableRow>)}</TableBody></Table> : <Message kind="empty" title="暂无保证金记录" />}
      {data.transactions?.map((item: any) => <div key={item.requirementId} className="grid gap-2"><h4 className="text-sm font-medium">{item.accountId}</h4>
        {item.paymentHistory?.length ? <Collapsible><CollapsibleTrigger render={<Button variant="outline" size="sm" />}>支付尝试 {item.paymentHistory.length} 笔</CollapsibleTrigger><CollapsibleContent><Table><TableHeader><TableRow><TableHead>商户单号</TableHead><TableHead>金额</TableHead><TableHead>记录状态</TableHead></TableRow></TableHeader><TableBody>{item.paymentHistory.map((attempt: any) => <TableRow key={attempt.id}><TableCell>{attempt.merchantOrderNo || attempt.id}</TableCell><TableCell>{financeMoney(attempt.observedAmountCents ?? attempt.amountCents)}</TableCell><TableCell>{guaranteeLabels[attempt.status] ?? '待核'}</TableCell></TableRow>)}</TableBody></Table></CollapsibleContent></Collapsible> : null}
        {item.refundHistory?.length ? <Collapsible><CollapsibleTrigger render={<Button variant="outline" size="sm" />}>退款尝试 {item.refundHistory.length} 笔</CollapsibleTrigger><CollapsibleContent><Table><TableHeader><TableRow><TableHead>退款单号</TableHead><TableHead>金额</TableHead><TableHead>记录状态</TableHead></TableRow></TableHeader><TableBody>{item.refundHistory.map((attempt: any) => <TableRow key={attempt.id}><TableCell>{attempt.id}</TableCell><TableCell>{financeMoney(attempt.amountCents)}</TableCell><TableCell>{guaranteeLabels[attempt.status] ?? '待核'}</TableCell></TableRow>)}</TableBody></Table></CollapsibleContent></Collapsible> : null}
      </div>)}
      <AdminOwnerGuaranteeHistory subjectUserId={user.id} adminUserId={adapter.snapshot.adminUserId} scopeKey={JSON.stringify([subject, refreshNonce, revision, adapter.snapshot.security, [...adapter.snapshot.permissions].sort()])} canRead={enabled && adapter.hasCreditGuaranteeRead()} />
    </CollapsibleContent></Collapsible> : null}
    <Dialog open={dialog !== null} onOpenChange={value => { if (!value) setDialog(null); }}><DialogContent closeLabel="关闭" className="sm:max-w-md"><form className="grid gap-4" onSubmit={event => { event.preventDefault(); submit(); }}>
      <DialogHeader><DialogTitle>{dialog === 'deduct' ? '手动扣分' : '更正扣分'}</DialogTitle><DialogDescription>{user.name} · 当前 {score ?? '未知'} 分{dialog && dialog !== 'deduct' ? `，原扣分 ${Math.abs(dialog.appliedDeltaScore)} 分` : ''}</DialogDescription></DialogHeader>
      {dialog === 'deduct' ? <Field label="扣分数量" hint={score === null ? '信用分尚未建立' : `可扣 1–${score} 分`} required><Input aria-label="扣分数量" inputMode="numeric" autoComplete="off" value={amount} onChange={event => setAmount(event.target.value)} /></Field> : null}
      <Field label={dialog === 'deduct' ? '扣分说明' : '更正说明'} hint="用户可以看到这条说明，2–500 字。" required><Textarea aria-label={dialog === 'deduct' ? '扣分说明' : '更正说明'} rows={4} maxLength={500} value={explanation} onChange={event => setExplanation(event.target.value)} /></Field>
      <DialogFooter><Button type="button" variant="outline" onClick={() => setDialog(null)}>取消</Button><Button type="submit" variant={dialog === 'deduct' ? 'destructive' : 'default'} disabled={!canWrite || busy || !knownRevision || !reasonValid || (dialog === 'deduct' && !amountValid)}>{dialog === 'deduct' ? '确认扣分' : '确认更正'}</Button></DialogFooter>
    </form></DialogContent></Dialog>
  </div>;
}
