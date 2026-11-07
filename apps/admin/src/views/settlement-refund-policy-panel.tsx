import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { StatusMessage } from "../components/ui-elements";

type Policy = { normalDays: number; earlyDays: number; revision: string; available: boolean };
type Command = { actorId: string; key: string; normalDays: number; earlyDays: number; expectedRevision: string };
const path = "/system/settlement-refund-policy";
const storageKey = (actorId: string) => `zzsh.admin.settlement-refund-policy:${actorId}`;
const days = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 365;

function parsePolicy(value: unknown): Policy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("退款等待期返回格式不正确");
  const p = value as Record<string, unknown>;
  if (!days(p.normalDays) || !days(p.earlyDays) || typeof p.available !== "boolean" || typeof p.revision !== "string"
    || !(p.available ? /^[1-9]\d{0,18}$/.test(p.revision) : p.revision === "0")) throw new Error("退款等待期返回格式不正确");
  return { normalDays: p.normalDays, earlyDays: p.earlyDays, revision: p.revision, available: p.available };
}
function readCommand(actorId: string): Command | null {
  const text = window.sessionStorage.getItem(storageKey(actorId));
  if (text === null) return null;
  const c = JSON.parse(text) as Command;
  if (c.actorId !== actorId || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.key) || !days(c.normalDays) || !days(c.earlyDays)
    || typeof c.expectedRevision !== "string" || !/^[1-9]\d{0,18}$/.test(c.expectedRevision)) throw new Error("原操作记录无法读取，请联系技术人员处理。");
  return c;
}

export function SettlementRefundPolicyPanel({ actorId, sessionId }: { actorId: string; sessionId: string }) {
  return <PolicyDialog key={`${actorId}:${sessionId}`} actorId={actorId} />;
}
function PolicyDialog({ actorId }: { actorId: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null), [normal, setNormal] = useState(""), [early, setEarly] = useState("");
  const [pending, setPending] = useState<Command | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const generation = useRef(0), alive = useRef(true), writing = useRef(false), readAbort = useRef<AbortController | null>(null);

  async function load() {
    readAbort.current?.abort();
    const controller = new AbortController(); readAbort.current = controller;
    const run = ++generation.current; setLoading(true); setError("");
    try {
      const value = parsePolicy(await adminRequest(path, undefined, "GET", {}, controller.signal));
      if (!alive.current || controller.signal.aborted || run !== generation.current) return;
      setPolicy(value); setNormal(String(value.normalDays)); setEarly(String(value.earlyDays));
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && run === generation.current) { setPolicy(null); setError(friendlyError(failure)); }
    } finally { if (alive.current && run === generation.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; readAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!open) { generation.current++; readAbort.current?.abort(); return; }
    try { setPending(readCommand(actorId)); setStorageBlocked(false); }
    catch { setStorageBlocked(true); setError("原操作记录无法读取，请联系技术人员处理。"); }
    setNotice(""); void load();
  }, [open, actorId]);

  async function send(command: Command) {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await adminRequest<{ policy: unknown; changed: unknown }>(path,
        { normalDays: command.normalDays, earlyDays: command.earlyDays, expectedRevision: command.expectedRevision },
        "PUT", { "idempotency-key": command.key });
      const value = parsePolicy(result?.policy);
      if (!value.available || value.normalDays !== command.normalDays || value.earlyDays !== command.earlyDays || typeof result.changed !== "boolean"
        || BigInt(value.revision) !== BigInt(command.expectedRevision) + (result.changed ? 1n : 0n)) throw new Error("保存结果待核对，请重试原操作。");
      window.sessionStorage.removeItem(storageKey(actorId));
      if (!alive.current) return;
      generation.current++; readAbort.current?.abort(); setLoading(false);
      setPending(null); setPolicy(null);
      setNotice("保存操作已确认，最新设置适用于之后结算的订单。");
      await load();
    } catch (failure) {
      if (!alive.current) return;
      if (failure instanceof AdminApiError && [400, 409, 422].includes(failure.status) && failure.code !== "IDEMPOTENCY_KEY_REUSED") {
        try { window.sessionStorage.removeItem(storageKey(actorId)); setPending(null); } catch { setStorageBlocked(true); }
        void load();
        setError("设置未保存，请核对最新设置后重试。");
      } else setError("保存结果暂未确认，请重试原操作或联系技术人员核对。");
    } finally { writing.current = false; if (alive.current) setBusy(false); }
  }
  function save() {
    if (!policy?.available || pending || storageBlocked || writing.current || !/^\d+$/.test(normal) || !/^\d+$/.test(early)) return;
    const normalDays = Number(normal), earlyDays = Number(early);
    if (!days(normalDays) || !days(earlyDays)) { setError("请输入 0 至 365 的整数天数。"); return; }
    const command = { actorId, key: `settlement-policy-${crypto.randomUUID()}`, normalDays, earlyDays, expectedRevision: policy.revision };
    try { window.sessionStorage.setItem(storageKey(actorId), JSON.stringify(command)); setPending(command); }
    catch { setStorageBlocked(true); setError("无法保存操作记录，请检查浏览器存储后重试。"); return; }
    void send(command);
  }
  const valid = /^\d+$/.test(normal) && /^\d+$/.test(early) && days(Number(normal)) && days(Number(early));
  return <>
    <Button type="button" variant="outline" onClick={() => setOpen(true)}>设置退款等待期</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent>
      <div className="space-y-5">
        <div><DialogTitle>设置退款等待期</DialogTitle><DialogDescription>结算生效后，退款按对应等待期处理；提交和到账请查看具体退款进度。已结算订单保持原到期时间。</DialogDescription></div>
        {loading ? <p role="status" className="text-sm text-muted-foreground">正在读取设置…</p> : null}
        {error ? <StatusMessage error={error} /> : null}
        {notice ? <StatusMessage success={notice} /> : null}
        {storageBlocked ? <StatusMessage error="操作记录无法读取或保存，暂不能修改设置，请联系技术人员。" /> : null}
        {pending ? <div className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm"><p>上次保存的结果待确认，重试会使用原操作，不会新建另一笔。</p><Button type="button" variant="outline" disabled={busy} onClick={() => void send(pending)}>重试原操作</Button></div> : null}
        {policy && !policy.available ? <p className="text-sm text-muted-foreground">退款等待期设置尚未安装，暂不可修改。</p> : null}
        {policy?.available ? <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span>正常结算（天）</span><Input inputMode="numeric" value={normal} disabled={busy || !!pending || storageBlocked} onChange={e => setNormal(e.target.value)} /></label>
          <label className="space-y-1 text-sm"><span>提前结算（天）</span><Input inputMode="numeric" value={early} disabled={busy || !!pending || storageBlocked} onChange={e => setEarly(e.target.value)} /></label>
        </div> : null}
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">0 表示结算后即可处理退款；范围 0–365 天。</p><Button type="button" disabled={!policy?.available || !valid || busy || loading || !!pending || storageBlocked || normal === String(policy?.normalDays) && early === String(policy?.earlyDays)} onClick={save}>{busy ? "保存中…" : "保存设置"}</Button></div>
      </div>
    </DialogContent></Dialog>
  </>;
}
