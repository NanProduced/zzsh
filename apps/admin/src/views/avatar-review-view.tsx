import { useEffect, useMemo, useRef, useState } from "react";
import { formatBeijingDateTime } from "../workspace/beijing-time";
import { CheckIcon, RefreshCw, ShieldAlertIcon, ShieldXIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { SettingsNotice } from "./self-settings/settings-shell";
import { AdminAvatarError, adminAvatarReviewContentUrl, assertAvatarReviewReceipt, clearPendingAdminAvatar, readAdminAvatarOperationResult, readAdminAvatarReviews, readPendingAdminAvatar, reviewAdminAvatar, savePendingAdminAvatar, withdrawAdminAvatar, type AdminAvatarReviewItem, type PendingAdminAvatar } from "./self-settings/avatar-api";

const STATES = ["PENDING", "APPROVED", "REJECTED", "QUARANTINED"] as const;
type State = typeof STATES[number];
type Action = { kind: "APPROVE" | "REJECT" | "QUARANTINE" | "WITHDRAW"; item: AdminAvatarReviewItem } | null;
type ReviewProps = { snapshot: { adminUserId: string; security: { isBoss: boolean; status: string }; session?: {id:string;locked?:boolean}; permissions: string[] }; refreshNonce: number };
export function AvatarReviewView(props: ReviewProps) {
  const {snapshot}=props;
  const allowed=snapshot.security.status === "ACTIVE" && snapshot.session?.locked !== true && (snapshot.security.isBoss || snapshot.permissions.includes("profile.avatar.review"));
  return <AvatarReviewBody key={snapshot.adminUserId + ":" + (snapshot.session?.id ?? "") + ":" + allowed} {...props} allowed={allowed} />;
}
function AvatarReviewBody({ snapshot, refreshNonce, allowed }: ReviewProps & {allowed:boolean}) {
  const [state, setState] = useState<State>("PENDING");
  const [items, setItems] = useState<AdminAvatarReviewItem[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [action, setAction] = useState<Action>(null), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<PendingAdminAvatar | null>(null), [storageBlocked, setStorageBlocked] = useState(false);
  const alive = useRef(true), writing = useRef(false), readSequence = useRef(0);
  const readAbort = useRef<AbortController | null>(null), writeAbort = useRef<AbortController | null>(null);
  const current = () => alive.current;
  const load = async (append = false) => {
    if (!allowed) { setLoading(false); return; }
    readAbort.current?.abort(); const controller=new AbortController(); readAbort.current=controller;
    const sequence=++readSequence.current;
    append ? setLoadingMore(true) : setLoading(true);
    if (!append) { setItems([]); setNextCursor(null); }
    setError("");
    try {
      const page=await readAdminAvatarReviews(state,append?nextCursor:null,20,controller.signal);
      if (!current() || readSequence.current !== sequence) return;
      setItems(old=>append?[...old,...page.items]:page.items);setNextCursor(page.nextCursor);
    } catch (failure) { if (!controller.signal.aborted && current() && readSequence.current === sequence) setError(messageOf(failure,"头像审核列表读取失败")); }
    finally { if (current() && readSequence.current === sequence) {setLoading(false);setLoadingMore(false);} }
  };
  useEffect(()=>{
    alive.current=true;
    try {setPending(readPendingAdminAvatar(snapshot.adminUserId,"review"));} catch(failure){setStorageBlocked(true);setError(messageOf(failure,"原审核记录不可读"));}
    return()=>{alive.current=false;readSequence.current++;readAbort.current?.abort();writeAbort.current?.abort();};
  },[snapshot.adminUserId]);
  useEffect(()=>{void load();/* eslint-disable-next-line react-hooks/exhaustive-deps */},[state,refreshNonce,allowed]);
  const openAction=(item:AdminAvatarReviewItem,kind:NonNullable<Action>["kind"])=>{
    if (writing.current || pending || storageBlocked || !allowed) return;
    setAction({item,kind});setReason("");setError("");
  };
  function beginWrite(){if(writing.current||!allowed)return null;writing.current=true;setBusy(true);setError("");const controller=new AbortController();writeAbort.current=controller;return controller;}
  function release(command:PendingAdminAvatar){clearPendingAdminAvatar(command);setPending(null);}
  async function recover(){
    const controller=beginWrite();if(!controller)return;
    try{
      const command=readPendingAdminAvatar(snapshot.adminUserId,"review");if(!command){setPending(null);return;}setPending(command);
      const result=await readAdminAvatarOperationResult(command,controller.signal);if(!current())return;
      if(result.receipt==="UNRESOLVED"){setNotice("原审核结果仍未确认，请稍后再读取；不会重新提交。");return;}
      release(command);setAction(null);setNotice(result.responseStatus<300?"原审核操作已确认，正在读取当前队列。":"原审核已被拒绝，已解除原待确认记录。");await load();
    }catch(failure){if(current())setError(messageOf(failure,"原审核结果尚未确认"));}
    finally{if(current()){writing.current=false;setBusy(false);}}
  }
  const submit=async()=>{
    if(!action||busy||pending||storageBlocked||!allowed)return;
    if(action.kind!=="APPROVE"&&reason.trim().length<2){setError("请填写至少2个字符的原因。");return;}
    if(!/^[1-9]\d{0,18}$/.test(action.item.revision)){setError("原审核版本无效，请重新读取队列。");return;}
    const controller=beginWrite();if(!controller)return;
    let command:PendingAdminAvatar|null=null;
    try{
      const prior=readPendingAdminAvatar(snapshot.adminUserId,"review");if(prior){setPending(prior);setNotice("请先读取原审核结果。");return;}
      command={actorId:snapshot.adminUserId,slot:"review",key:"avatar-review-"+crypto.randomUUID(),assetId:action.item.assetId,action:action.kind,reason:reason.trim()||null,expectedRevision:action.item.revision};
      savePendingAdminAvatar(command);setPending(command);
      const result=action.kind==="WITHDRAW"?await withdrawAdminAvatar(command.assetId!,command.reason!,command.expectedRevision,command.key,controller.signal):await reviewAdminAvatar(command.assetId!,action.kind,command.reason??null,command.expectedRevision,command.key,controller.signal);
      assertAvatarReviewReceipt(result,command.assetId!);if(!current())return;
      setAction(null);setNotice(action.kind==="APPROVE"?"审核已通过；仅仍为最新提交时才生效。":action.kind==="WITHDRAW"?"已撤回公开读取；当前使用者回退默认头像。":"已记录审核结果。");
      try{release(command);}catch{setNotice("审核已确认，本地记录待清理，请读取原审核结果。");}
      await load();
    }catch(failure){
      if(!current())return;
      if(command&&failure instanceof AdminAvatarError&&[400,401,403,404,409,413,415,422,429].includes(failure.status)){try{release(command);}catch{setPending(command);}}
      setError(messageOf(failure,"审核结果未确认，请读取原结果"));
    }finally{if(current()){writing.current=false;setBusy(false);}}
  };

  const empty = useMemo(() => !loading && !error && items.length === 0, [loading, error, items.length]);
  if (!allowed) return <div className="p-6"><SettingsNotice tone="warning" role="alert">当前账号没有头像审核权限（profile.avatar.review）。</SettingsNotice></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">用户与会员</p>
          <h1 className="text-xl font-semibold">头像审核</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">审核用户与管理员本人上传的头像。默认头像为预审资源，不在此队列；本权限不包含目录素材或其他身份资料。</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading || loadingMore || busy}><RefreshCw />刷新</Button>
      </div>
      {error ? <SettingsNotice tone="danger" role="alert">{error}</SettingsNotice> : null}
      {notice ? <SettingsNotice tone="success" role="status">{notice}</SettingsNotice> : null}
      {storageBlocked ? <SettingsNotice tone="danger">原审核操作记录不可读，暂不能发起新审核。</SettingsNotice> : null}
      {pending ? <SettingsNotice tone="warning"><p>原审核操作结果待确认（{pending.assetId}），不会新建请求。</p><Button type="button" variant="secondary" disabled={busy} onClick={() => void recover()}>读取原审核结果</Button></SettingsNotice> : null}

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1" role="group" aria-label="审核状态">
        {STATES.map((value) => (
          <button key={value} type="button" aria-pressed={state === value} onClick={() => { setState(value); setNextCursor(null); }}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${state === value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {stateLabel(value)}
          </button>
        ))}
      </div>

      {loading ? <p className="text-muted-foreground text-sm" role="status">正在读取…</p> : null}
      {empty ? <p className="text-muted-foreground text-sm">当前状态没有待处理的头像。</p> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <article key={item.assetId} className="flex gap-3 rounded-xl border border-border bg-background p-3">
            <img className="size-20 flex-none rounded-full border border-border object-cover" src={adminAvatarReviewContentUrl(item.assetId)} alt={`${item.subjectName ?? item.subjectId} 的头像`} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="truncate text-sm">{item.subjectName ?? "未命名主体"}</strong>
                <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.realm === "admin" ? "管理员" : "用户"}</span>
              </div>
              <p className="text-muted-foreground truncate font-mono text-[11px]">{item.subjectId}</p>
              <p className="text-muted-foreground text-xs">{formatTime(item.submittedAt)} · {item.width}×{item.height} · {formatBytes(item.byteSize)}</p>
              {item.reviewReason ? <p className="text-muted-foreground line-clamp-2 text-xs">原因：{item.reviewReason}</p> : null}
              {item.reviewState === "PENDING" ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button type="button" size="sm" disabled={busy || Boolean(pending) || storageBlocked} onClick={() => openAction(item, "APPROVE")}><CheckIcon />通过</Button>
                  <Button type="button" size="sm" variant="secondary" disabled={busy || Boolean(pending) || storageBlocked} onClick={() => openAction(item, "REJECT")}><XIcon />拒绝</Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(pending) || storageBlocked} onClick={() => openAction(item, "QUARANTINE")}><ShieldAlertIcon />隔离</Button>
                </div>
              ) : item.reviewState === "APPROVED" && item.accessClass === "PUBLIC_DISPLAY" ? (
                <div className="pt-1"><Button type="button" size="sm" variant="outline" disabled={busy || Boolean(pending) || storageBlocked} onClick={() => openAction(item, "WITHDRAW")}><ShieldXIcon />撤回公开</Button></div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {nextCursor ? <div className="flex justify-center"><Button type="button" variant="secondary" onClick={() => void load(true)} disabled={loadingMore}>{loadingMore ? "加载中…" : "加载更多"}</Button></div> : null}

      <Dialog open={Boolean(action)} onOpenChange={(open) => { if (!open && !busy) setAction(null); }}>
        <DialogContent size="md">
          <DialogTitle>{action ? actionTitle(action.kind) : "头像审核"}</DialogTitle>
          {action ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                <img className="size-14 rounded-full object-cover" src={adminAvatarReviewContentUrl(action.item.assetId)} alt="" />
                <div className="min-w-0 text-sm">
                  <div className="truncate font-medium">{action.item.subjectName ?? action.item.subjectId}</div>
                  <div className="text-muted-foreground font-mono text-[11px]">{action.item.assetId}</div>
                </div>
              </div>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">审核原因{action.kind === "APPROVE" ? "（可选）" : ""}</span>
                <Input disabled={busy || Boolean(pending)} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder={action.kind === "APPROVE" ? "可留空" : "说明拒绝、隔离或撤回的原因"} autoFocus />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">原审核版本（CAS）</span>
                <Input aria-label="原审核版本" value={action.item.revision} readOnly />
                <span className="text-muted-foreground text-xs">固定使用列表读取的版本；并发变化时需重新读取，不能跳过版本校验。</span>
              </label>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAction(null)} disabled={busy}>取消</Button>
                <Button type="button" onClick={() => void submit()} disabled={busy || Boolean(pending) || storageBlocked}>{busy ? "提交中…" : "确认"}</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function stateLabel(value: State): string {
  return value === "PENDING" ? "待审核" : value === "APPROVED" ? "已通过" : value === "REJECTED" ? "已拒绝" : "已隔离";
}
function actionTitle(kind: NonNullable<Action>["kind"]): string {
  return kind === "APPROVE" ? "通过头像" : kind === "REJECT" ? "拒绝头像" : kind === "QUARANTINE" ? "隔离头像" : "撤回公开头像";
}
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof AdminAvatarError) return error.requestId ? `${error.message}（请求编号 ${error.requestId}）` : error.message;
  return error instanceof Error && error.message ? error.message : fallback;
}
function formatTime(value: string): string {
  return formatBeijingDateTime(value, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false });
}
function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
