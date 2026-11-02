import { useCallback, useEffect, useRef, useState } from "react";

import { adminRequest, friendlyError, type SessionSnapshot } from "../../api";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { parseDashboardPayload, type DashboardPayload, type DashboardRange } from "../../components/dashboard/model";
import { BossDashboard } from "./boss-dashboard";
import { OpsDashboard } from "./ops-dashboard";
import { SupportDashboard } from "./support-dashboard";

export function DashboardPage({
  snapshot,
  onNavigate,
  refreshNonce,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onNavigate: (path: string) => void;
  refreshNonce: number;
}) {
  const [range, setRange] = useState<DashboardRange>("30d");
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ owner: string; data: DashboardPayload | null; error: string; busy: boolean }>({
    owner: "",
    data: null,
    error: "",
    busy: true,
  });
  // loginTwoFactorRequired is an account policy; this snapshot is already authenticated.
  const active = snapshot.security.status === "ACTIVE" && !snapshot.session.locked && !snapshot.security.passwordChangeRequired;
  const owner = JSON.stringify({ ...snapshot, user: undefined, permissions: [...snapshot.permissions].sort(), range, refreshNonce, reload });
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const generation = useRef(0);
  const request = useRef<{ controller: AbortController; generation: number } | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!active || currentOwner.current !== owner || quiet && request.current && !request.current.controller.signal.aborted) return;
    request.current?.controller.abort();
    const controller = new AbortController(), id = ++generation.current;
    request.current = { controller, generation: id };
    const { signal } = controller;
    const valid = () => !signal.aborted && currentOwner.current === owner && generation.current === id;
    setState((previous) => ({ owner, data: quiet && previous.owner === owner ? previous.data : null, error: "", busy: true }));
    try {
      const data = parseDashboardPayload(await adminRequest<unknown>(`/dashboard?range=${range}`, undefined, "GET", {}, signal));
      if (data.period.range !== range) throw new Error("服务端返回的时间范围与当前选择不一致。");
      if (valid()) setState({ owner, data, error: "", busy: false });
    } catch (error) {
      if (valid()) setState({ owner, data: null, error: friendlyError(error), busy: false });
    } finally {
      if (request.current?.generation === id) request.current = null;
    }
  }, [active, owner, range]);

  useEffect(() => {
    void load();
    return () => {
      request.current?.controller.abort();
      request.current = null;
      generation.current++;
    };
  }, [load]);

  const preset = state.owner === owner ? state.data?.preset : undefined;
  useEffect(() => {
    if (!active || !preset || preset === "BOSS") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [active, load, preset]);

  const current = state.owner === owner ? state : { data: null, error: "", busy: true };
  const data = current.data;
  const refreshing = current.busy && Boolean(data);
  if (!active) return <Alert variant="warning"><AlertTitle>当前会话无法读取工作台</AlertTitle><AlertDescription>请先解锁或完成账号安全要求。</AlertDescription></Alert>;
  return <div className="space-y-4">
    {current.error ? <Alert variant="destructive">
      <AlertTitle>工作台暂时无法读取</AlertTitle>
      <AlertDescription>没有显示上一次的统计，避免把旧数据当作当前结果。{current.error}</AlertDescription>
      <div className="col-span-2 mt-2"><Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>重试</Button></div>
    </Alert> : null}
    {!data && !current.error ? <DashboardSkeleton /> : null}
    {data ? <DashboardContent data={data} snapshot={snapshot} range={range} onRange={setRange} onRefresh={() => setReload((value) => value + 1)} refreshing={refreshing} onNavigate={onNavigate} /> : null}
  </div>;
}

function DashboardContent({
  data,
  snapshot,
  range,
  onRange,
  onRefresh,
  refreshing,
  onNavigate,
}: {
  data: DashboardPayload;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  range: DashboardRange;
  onRange: (range: DashboardRange) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onNavigate: (path: string) => void;
}) {
  if (data.preset === "BOSS") return <BossDashboard data={data} range={range} onRange={onRange} onRefresh={onRefresh} refreshing={refreshing} onNavigate={onNavigate} />;
  if (data.preset === "SUPPORT") return <SupportDashboard data={data} snapshot={snapshot} range={range} onRange={onRange} onRefresh={onRefresh} refreshing={refreshing} onNavigate={onNavigate} />;
  return <OpsDashboard data={data} range={range} onRange={onRange} onRefresh={onRefresh} refreshing={refreshing} onNavigate={onNavigate} />;
}

function DashboardSkeleton() {
  return <div className="space-y-5" aria-busy="true" aria-label="正在读取工作台">
    <div className="h-16 animate-pulse rounded-lg bg-muted" />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-36 animate-pulse rounded-xl bg-muted" />)}</div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"><div className="h-80 animate-pulse rounded-xl bg-muted" /><div className="h-80 animate-pulse rounded-xl bg-muted" /></div>
  </div>;
}
