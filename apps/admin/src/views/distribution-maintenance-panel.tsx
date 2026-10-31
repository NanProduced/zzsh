import { useCallback, useEffect, useRef, useState } from 'react';
import { adminRequest, AdminApiError } from '../api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type OrderRow = { orderId: string; status: string; reason: string | null; items: Array<{ role: string; state: string }> };
type Scan = { scope: string; examined: number; orders: OrderRow[]; asOf?: string };
type Command = { scope: string; requested?: number; selected?: number; attempted: number; notAttempted: number; recoveryRequired?: boolean; results: Array<{ orderId?: string; earningId?: string; status: string; reason?: string }> };

const requestId = () => 'distmaint_' + (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll('-', '');

/** Operator-only, explicit commands. Opening the page never writes money. */
export function DistributionMaintenancePanel() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'replay' | 'due' | null>(null);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setError('');
    try {
      const value = await adminRequest<Scan>('/distribution/maintenance/accruals?limit=20', undefined, 'GET', {}, controller.signal);
      if (!controller.signal.aborted) setScan(value);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof AdminApiError ? reason.message : '漏计提检查未能完成');
    }
  }, []);
  useEffect(() => { void load(); return () => active.current?.abort(); }, [load]);
  const run = async (kind: 'replay' | 'due') => {
    setConfirm(null); setBusy(true); setError(''); setNotice('');
    try {
      const value = kind === 'replay'
        ? await adminRequest<Command>('/distribution/maintenance/accruals/replay', { orderIds: (scan?.orders ?? []).filter(o => o.status === 'MISSING' || o.status === 'PARTIAL').map(o => o.orderId).slice(0, 100), requestId: requestId() }, 'POST')
        : await adminRequest<Command>('/distribution/maintenance/due-settlements', { limit: 20, requestId: requestId() }, 'POST');
      setNotice(`${kind === 'replay' ? '重放' : '到期入账'}处理 ${value.attempted ?? value.results.length}/${value.selected ?? value.requested ?? 0}，未执行 ${value.notAttempted}${value.recoveryRequired ? '；存在 UNKNOWN，请先读原回执' : ''}`);
      await load();
    } catch (reason) {
      setError(reason instanceof AdminApiError ? reason.message : '维护命令结果未知，请按原请求重读回执');
    } finally { setBusy(false); }
  };
  const recoverable = (scan?.orders ?? []).filter(o => o.status === 'MISSING' || o.status === 'PARTIAL');
  return <section className="space-y-3 rounded-xl border p-4" aria-label="分销计提维护">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-semibold">计提维护</h2><p className="mt-1 text-sm text-muted-foreground">只按原 posting、原 basis 和原经济根检查或重放；打开页面不写钱。</p></div>
      <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void load()}>重新检查</Button>
        <Button variant="outline" disabled={busy || !recoverable.length} onClick={() => setConfirm('replay')}>重放可恢复漏计提</Button>
        <Button disabled={busy} onClick={() => setConfirm('due')}>执行到期入账</Button></div>
    </div>
    {error ? <Alert variant="destructive"><AlertTitle>维护未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <Alert><AlertTitle>维护结果</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <p className="text-xs text-muted-foreground">最近检查 {scan ? `${scan.examined} 单 · ${scan.scope}` : '…'}；CONFLICT/UNKNOWN 不自动修复。</p>
    {scan?.orders.length ? <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>原订单</TableHead><TableHead>检查结果</TableHead><TableHead>原因</TableHead></TableRow></TableHeader><TableBody>
      {scan.orders.map(order => <TableRow key={order.orderId}><TableCell className="font-mono text-xs">{order.orderId}</TableCell><TableCell>{order.status}</TableCell><TableCell className="text-xs text-muted-foreground">{order.reason ?? order.items.map(item => `${item.role}:${item.state}`).join(' · ')}</TableCell></TableRow>)}
    </TableBody></Table></div> : <p className="text-sm text-muted-foreground">当前范围内没有可检查的结算过账。</p>}
    <Dialog open={confirm !== null} onOpenChange={value => { if (!value) setConfirm(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{confirm === 'replay' ? '重放漏计提' : '执行到期入账'}</DialogTitle><DialogDescription>这会把结果写入原分销账本；命令按原经济根幂等，UNKNOWN 时先读原回执再恢复。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>取消</Button><Button disabled={busy} onClick={() => void run(confirm!)}>确认执行</Button></DialogFooter></DialogContent>
    </Dialog>
  </section>;
}
