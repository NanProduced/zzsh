import { useCallback, useEffect, useRef, useState } from 'react';
import { adminRequest, AdminApiError } from '../api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type OrderRow = { orderId: string; status: string; reason: string | null; items: Array<{ role: string; state: string }>; postedAt: string };
type Scan = { scope: string; examined: number; orders: OrderRow[]; nextCursor: string | null; asOf?: string };
type Batch = { schema: string; operation: 'ACCRUALS_REPLAY' | 'DUE_SETTLE'; state: 'PLANNED' | 'RUNNING' | 'COMPLETE' | 'UNKNOWN'; requestId: string; fingerprint: string;
  plan: { earningIds?: Array<{ earningId: string; version: string }>; orderIds?: string[] }; results: Array<{ id: string; status: string; errorCode?: string }>; notAttempted: number };
type BatchResponse = { batch: Batch; httpStatus: number; replayed: boolean };
type Pending = { kind: 'replay' | 'due'; requestId: string; body: Record<string, unknown> };

const newRequestId = () => 'distmaint_' + (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll('-', '');

/** Operator-only, explicit commands. Opening the page never writes money. */
export function DistributionMaintenancePanel() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'replay' | 'due' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor: string | null = null) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setError('');
    try {
      const params = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
      const value = await adminRequest<Scan>(`/distribution/maintenance/accruals?${params}`, undefined, 'GET', {}, controller.signal);
      if (controller.signal.aborted) return;
      setScan(value);
      setOrders(current => {
        if (!cursor) return value.orders;
        const seen = new Set(current.map(order => order.orderId));
        return [...current, ...value.orders.filter(order => !seen.has(order.orderId))];
      });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof AdminApiError ? reason.message : '漏计提检查未能完成');
    }
  }, []);
  useEffect(() => { void load(); return () => active.current?.abort(); }, [load]);
  const send = async (value: Pending) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await adminRequest<BatchResponse>(value.kind === 'replay' ? '/distribution/maintenance/accruals/replay' : '/distribution/maintenance/due-settlements', value.body, 'POST');
      setBatch(result.batch);
      setNotice(`${value.kind === 'replay' ? '漏计提重放' : '到期入账'}：${result.batch.state}，已处理 ${result.batch.results.length}/${(result.batch.plan.earningIds ?? result.batch.plan.orderIds ?? []).length}，未执行 ${result.batch.notAttempted}${result.batch.state === 'UNKNOWN' ? '；原批次已保留，先读回执再决定' : ''}`);
      if (result.batch.state === 'COMPLETE') { pendingRef.current = null; setPending(null); }
      await load();
    } catch (reason) {
      pendingRef.current = value; setPending(value);
      setError(reason instanceof AdminApiError ? `${reason.message}；原 key/body 已保留，可读原批次或重试同一请求` : '维护命令结果未知；原 key/body 已保留');
    } finally { setBusy(false); }
  };
  const start = (kind: 'replay' | 'due') => {
    if (pendingRef.current) return;
    setBatch(null); setConfirm(null);
    const requestId = newRequestId();
    const value: Pending = kind === 'replay'
      ? { kind, requestId, body: { orderIds: orders.filter(order => order.status === 'MISSING' || order.status === 'PARTIAL').map(order => order.orderId).slice(0, 100), requestId } }
      : { kind, requestId, body: { limit: 20, requestId } };
    pendingRef.current = value; setPending(value);
    void send(value);
  };
  const recover = async () => {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const result = await adminRequest<BatchResponse>(`/distribution/maintenance/batches/${encodeURIComponent(pending.requestId)}`, undefined, 'GET');
      setBatch(result.batch);
      setNotice(`原批次 ${result.batch.state}，已回放 ${result.batch.results.length}，未执行 ${result.batch.notAttempted}`);
      if (result.batch.state === 'COMPLETE') { pendingRef.current = null; setPending(null); }
    } catch (reason) {
      setError(reason instanceof AdminApiError ? reason.message : '原批次回执读取失败');
    } finally { setBusy(false); }
  };
  const retry = () => { if (pending) void send(pending); };
  const recoverable = orders.filter(order => order.status === 'MISSING' || order.status === 'PARTIAL');
  return <section className="space-y-3 rounded-xl border p-4" aria-label="分销计提维护">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-semibold">计提维护</h2><p className="mt-1 text-sm text-muted-foreground">按原 posting、basis 和经济根检查/重放；每次命令固定原批次，打开页面不写钱。</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void load()}>重新检查</Button>
        <Button variant="outline" disabled={busy || pending !== null || !recoverable.length} onClick={() => setConfirm('replay')}>重放可恢复漏计提</Button>
        <Button disabled={busy || pending !== null} onClick={() => setConfirm('due')}>执行到期入账</Button></div>
    </div>
    {error ? <Alert variant="destructive"><AlertTitle>维护未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <Alert><AlertTitle>维护结果</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
    {batch ? <div className="text-xs text-muted-foreground" aria-label="原批次回执">批次 {batch.requestId} · {batch.state} · 指纹 {batch.fingerprint.slice(0, 12)}… · 未执行 {batch.notAttempted}
    </div> : null}
    {pending ? <div className="text-xs text-muted-foreground" aria-label="原批次恢复">原请求 {pending.requestId}<Button variant="link" size="sm" disabled={busy} onClick={() => void recover()}>读原批次</Button><Button variant="link" size="sm" disabled={busy} onClick={retry}>重试原批次</Button></div> : null}
    <p className="text-xs text-muted-foreground">本页已检查 {orders.length} 单 · {scan?.scope ?? '范围待核'}；CONFLICT/UNKNOWN 不自动修复。</p>
    {orders.length ? <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>原订单</TableHead><TableHead>检查结果</TableHead><TableHead>原因</TableHead></TableRow></TableHeader><TableBody>
      {orders.map(order => <TableRow key={order.orderId}><TableCell className="font-mono text-xs">{order.orderId}</TableCell><TableCell>{order.status}</TableCell><TableCell className="text-xs text-muted-foreground">{order.reason ?? order.items.map(item => `${item.role}:${item.state}`).join(' · ')}</TableCell></TableRow>)}
    </TableBody></Table></div> : <p className="text-sm text-muted-foreground">当前范围内没有可检查的结算过账。</p>}
    {scan?.nextCursor ? <Button variant="outline" disabled={busy} onClick={() => void load(scan.nextCursor)}>继续检查更早记录</Button> : <p className="text-xs text-muted-foreground">已到达当前范围最早记录；没有下一页不等于没有漏计提，NEW 单需从最新重查。</p>}
    <Dialog open={confirm !== null} onOpenChange={value => { if (!value) setConfirm(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{confirm === 'replay' ? '重放漏计提' : '执行到期入账'}</DialogTitle><DialogDescription>这会按原经济根写入分销账本；同一请求重试只恢复原批次，UNKNOWN 时先读原回执。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>取消</Button><Button disabled={busy} onClick={() => start(confirm!)}>确认执行</Button></DialogFooter></DialogContent>
    </Dialog>
  </section>;
}
