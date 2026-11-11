import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { StatusMessage } from "../components/ui-elements";

type Policy = { waitMinutes: number; revision: string; available: boolean };
type Command = { actorId: string; key: string; waitMinutes: number; expectedRevision: string };
const path = "/system/opening-auto-confirm";
const storageKey = (actorId: string) => `zzsh.admin.opening-auto-confirm:${actorId}`;
const minutes = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10080;

function parsePolicy(value: unknown): Policy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("开租自动确认返回格式不正确");
  const p = value as Record<string, unknown>;
  if (!minutes(p.waitMinutes) || typeof p.available !== "boolean" || typeof p.revision !== "string"
    || !(p.available ? /^[1-9]\d{0,18}$/.test(p.revision) : p.revision === "0")) throw new Error("开租自动确认返回格式不正确");
  return { waitMinutes: p.waitMinutes, revision: p.revision, available: p.available };
}
function readCommand(actorId: string): Command | null {
  const text = window.sessionStorage.getItem(storageKey(actorId));
  if (text === null) return null;
  const c = JSON.parse(text) as Command;
  if (c.actorId !== actorId || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.key) || !minutes(c.waitMinutes)
    || typeof c.expectedRevision !== "string" || !/^[1-9]\d{0,18}$/.test(c.expectedRevision)) throw new Error("原操作记录无法读取，请联系技术人员处理。");
  return c;
}

export function OpeningAutoConfirmPolicyPanel({ actorId, sessionId }: { actorId: string; sessionId: string }) {
  return <PolicyDialog key={`${actorId}:${sessionId}`} actorId={actorId} />;
}
function PolicyDialog({ actorId }: { actorId: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null), [value, setValue] = useState("");
  const [pending, setPending] = useState<Command | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const generation = useRef(0), alive = useRef(true), writing = useRef(false), readAbort = useRef<AbortController | null>(null);

  async function load() {
    readAbort.current?.abort();
    const controller = new AbortController(); readAbort.current = controller;
    const run = ++generation.current; setLoading(true); setError("");
    try {
      const next = parsePolicy(await adminRequest(path, undefined, "GET", {}, controller.signal));
      if (!alive.current || controller.signal.aborted || run !== generation.current) return;
      setPolicy(next); setValue(String(next.waitMinutes));
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && run === generation.current) { setPolicy(null); setError(friendlyError(failure)); }
    } finally { if (alive.current && run === generation.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current++; readAbort.current?.abort(); }; }, []);
  useEffect(() => {
    if (!open) return;
    try { setPending(readCommand(actorId)); setStorageBlocked(false); }
    catch { setStorageBlocked(true); setError("原操作记录无法读取，请联系技术人员处理。"); }
    setNotice(""); void load();
  }, [open, actorId]);

  async function send(command: Command) {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await adminRequest<{ policy: unknown; changed: unknown }>(path,
        { waitMinutes: command.waitMinutes, expectedRevision: command.expectedRevision },
        "PUT", { "idempotency-key": command.key });
      const next = parsePolicy(result?.policy);
      if (!next.available || next.waitMinutes !== command.waitMinutes || typeof result.changed !== "boolean"
        || BigInt(next.revision) !== BigInt(command.expectedRevision) + (result.changed ? 1n : 0n)) throw new Error("保存结果待核对，请重试原操作。");
      window.sessionStorage.removeItem(storageKey(actorId));
      if (!alive.current) return;
      generation.current++; readAbort.current?.abort(); setLoading(false);
      setPending(null); setPolicy(null);
      setNotice("保存操作已确认，最新等待期只影响之后新生成的开租清单。");
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
    if (!policy?.available || pending || storageBlocked || writing.current || !/^\d+$/.test(value)) return;
    const waitMinutes = Number(value);
    if (!minutes(waitMinutes)) { setError("请输入 1 至 10080 的整数分钟。"); return; }
    const command = { actorId, key: `opening-auto-confirm-${crypto.randomUUID()}`, waitMinutes, expectedRevision: policy.revision };
    try { window.sessionStorage.setItem(storageKey(actorId), JSON.stringify(command)); setPending(command); }
    catch { setStorageBlocked(true); setError("无法保存操作记录，请检查浏览器存储后重试。"); return; }
    void send(command);
  }
  const valid = /^\d+$/.test(value) && minutes(Number(value));
  const isUnchanged = value === String(policy?.waitMinutes);
  const saveDisabled = !policy?.available || !valid || busy || loading || !!pending || storageBlocked || isUnchanged;
  const saveTitle = isUnchanged ? "数值未修改，无需保存" : !valid ? "请输入 1 至 10080 的整数分钟" : undefined;
  return <>
    <div className="flex flex-wrap items-center gap-3">
      {policy?.available ? (
        <span className="text-xs text-muted-foreground bg-muted/50 px-2.5 py-1 rounded">
          当前等待期：{policy.waitMinutes} 分钟
        </span>
      ) : null}
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>设置开租自动确认</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent>
      <div className="space-y-5">
        <div><DialogTitle>设置开租自动确认等待期</DialogTitle><DialogDescription>付款接纳后系统立即生成开租清单；清单生成后等待双方确认，超时按本设置补齐未确认方。修改只影响之后新生成的清单，已有清单截止时间不变。</DialogDescription></div>
        {loading ? <p role="status" className="text-sm text-muted-foreground">正在读取设置…</p> : null}
        {error ? <StatusMessage error={error} /> : null}
        {notice ? <StatusMessage success={notice} /> : null}
        {storageBlocked ? <StatusMessage error="操作记录无法读取或保存，暂不能修改设置，请联系技术人员。" /> : null}
        {pending ? <div className="space-y-2 rounded-lg border border-amber-500/40 p-3 text-sm"><p>上次保存的结果待确认，重试会使用原操作，不会新建另一笔。</p><Button type="button" variant="outline" disabled={busy} onClick={() => void send(pending)}>重试原操作</Button></div> : null}
        {policy && !policy.available ? <p className="text-sm text-muted-foreground">开租自动确认设置尚未安装，暂不可修改；系统仍按已有清单的截止时间处理。</p> : null}
        {policy?.available ? <label className="block max-w-xs space-y-1 text-sm"><span>等待期（分钟）</span><Input inputMode="numeric" value={value} disabled={busy || !!pending || storageBlocked} onChange={e => setValue(e.target.value)} /></label> : null}
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">范围 1–10080 分钟（最长 7 天）。0 不代表关闭或立即确认。</p><Button type="button" disabled={saveDisabled} title={saveTitle} onClick={save}>{busy ? "保存中…" : "保存设置"}</Button></div>
      </div>
    </DialogContent></Dialog>
  </>;
}
