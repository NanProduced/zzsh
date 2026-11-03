import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { BarChart, ChartBar, ChartContainer, XAxis, YAxis } from "../ui/chart";
import { DOMAIN_STATUS_LABELS, domainCount, domainSummaryReason, type DomainSummary } from "./domain-summary-model";

type State = { key: string; state: "loading" | "error" } | { key: string; state: "ready"; data: DomainSummary };
const time = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));

/** The server owns the full filtered set. Page rows and the browser clock never become statistics. */
export function DomainSummaryBlock({ domain, identity, queryKey, read, onStatus, refreshNonce, enabled = true }: {
  domain: DomainSummary["domain"];
  identity: string;
  queryKey: string;
  read: (signal: AbortSignal) => Promise<DomainSummary>;
  onStatus: (status: string) => void;
  refreshNonce: number;
  enabled?: boolean;
}) {
  const id = useId(), key = `${domain}:${identity}:${queryKey}`;
  const storageKey = `zzsh:domain-summary:${domain}`;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(storageKey) === "collapsed"; } catch { return false; } });
  const [nonce, setNonce] = useState(0), [state, setState] = useState<State>({ key, state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ key, state: "loading" });
    void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); }).then(data => { if (!controller.signal.aborted) setState({ key, state: "ready", data }); })
      .catch(() => { if (!controller.signal.aborted) setState({ key, state: "error" }); });
    return () => controller.abort();
  }, [key, enabled, nonce, refreshNonce, read]);
  useEffect(() => { const timer = window.setInterval(() => setNonce(value => value + 1), 300_000); return () => window.clearInterval(timer); }, []);
  const current = state.key === key && enabled ? state : { key, state: "loading" as const };
  const data = current.state === "ready" ? current.data : undefined;
  const known = data?.state === "KNOWN" ? data : undefined;
  const labels = DOMAIN_STATUS_LABELS[domain];
  const series = known?.statuses?.map(item => ({ ...item, label: labels[item.status], share: BigInt(known.total!) === 0n ? 0 : Number(BigInt(item.count) * 10_000n / BigInt(known.total!)) / 100 })) ?? [];
  const primary = domain === "USERS" ? ["ACTIVE", "RESTRICTED", "FROZEN"] : ["PENDING_PAYMENT", "PAID", "COMPLETED"];
  const toggle = () => { setCollapsed(value => { try { localStorage.setItem(storageKey, value ? "expanded" : "collapsed"); } catch {} return !value; }); };
  const busy = current.state === "loading";
  return <section className="mb-4 rounded-xl border border-border bg-card" aria-labelledby={`${id}-heading`}>
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0"><h2 id={`${id}-heading`} className="text-sm font-semibold">{domain === "USERS" ? "用户状态概览" : "订单状态概览"}</h2>
        <p className="mt-1 text-xs text-muted-foreground">当前已应用筛选与授权范围 · {data ? <time dateTime={data.asOf}>{time(data.asOf)}（北京时间）</time> : busy ? "正在读取统计时点" : "统计时点暂不可用"}</p></div>
      <div className="flex gap-1"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setNonce(value => value + 1)} aria-label="刷新状态概览"><RefreshCw size={14} aria-hidden />刷新</Button>
        <Button type="button" variant="ghost" size="sm" onClick={toggle} aria-expanded={!collapsed} aria-controls={`${id}-body`}>{collapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}{collapsed ? "展开" : "收起"}</Button></div>
    </div>
    <div id={`${id}-body`} hidden={collapsed} className="border-t border-border p-4">
      {busy ? <p className="py-5 text-sm text-muted-foreground" role="status">正在读取完整筛选结果的统计…</p>
        : current.state === "error" ? <p className="py-5 text-sm text-muted-foreground" role="status">状态概览暂时无法读取。请刷新重试；下方列表不受影响。</p>
          : !known ? <p className="py-5 text-sm text-muted-foreground" role="status">{data && domainSummaryReason(data)}</p>
            : <>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-4 lg:grid-cols-4">
                <div className="min-w-0"><dt className="text-xs text-muted-foreground">{domain === "USERS" ? "用户总数" : "订单总数"}</dt><dd className="mt-2"><button type="button" className="max-w-full break-words rounded-sm text-left text-2xl font-semibold tabular-nums underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:no-underline" disabled={!known.drilldown} onClick={() => onStatus(known.drilldown?.filters[domain === "USERS" ? "accountStatus" : "status"] ?? "")} aria-label={`查看当前筛选全部记录：${domainCount(known.total!)}`}>{domainCount(known.total!)}</button></dd></div>
                {primary.map(status => { const item = known.statuses!.find(value => value.status === status)!; return <div key={status} className="min-w-0"><dt className="text-xs text-muted-foreground">{labels[status]}</dt><dd className="mt-2"><button type="button" className="rounded-sm text-2xl font-semibold tabular-nums underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:no-underline" disabled={!item.drilldown} onClick={() => onStatus(status)} aria-label={`筛选${labels[status]}：${domainCount(item.count)}`}>{domainCount(item.count)}</button></dd></div>; })}
              </dl>
              <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(10rem,16rem)]">
                <ChartContainer label="当前筛选结果的状态占比" height={190} config={{ share: { label: "占比", color: "var(--chart-receipts)" } }}>
                  <BarChart data={series} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}><XAxis type="number" domain={[0, 100]} tickFormatter={value => `${value}%`} /><YAxis type="category" dataKey="label" width={72} tickLine={false} axisLine={false} />
                    <ChartBar dataKey="share" radius={3} onClick={entry => { const item = entry.payload; if (item?.drilldown && typeof item.status === "string") onStatus(item.status); }} />
                  </BarChart>
                </ChartContainer>
                <ul className="space-y-1 text-sm" aria-label="各状态精确数量">{series.map(item => <li key={item.status}><button type="button" className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent" disabled={!item.drilldown} onClick={() => onStatus(item.status)}><span>{item.label}</span><span className="tabular-nums">{domainCount(item.count)}</span></button></li>)}</ul>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{domain === "ORDERS" ? "按订单主状态统计；已付款不代表已交付，已完成不等于已结算或到账。" : "按账号当前状态统计，不代替实名、年龄及具体交易资格检查。"}</p>
            </>}
      {data?.membership && <p className="mt-3 text-xs text-muted-foreground">{data.membership.state === "FORBIDDEN" ? "当前权限不含会员分布。" : "会员等级分布暂不可用。"}</p>}
    </div>
  </section>;
}
