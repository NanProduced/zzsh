import { useEffect, useMemo, useState } from "react";
import { CheckIcon, RefreshCw, ShieldAlertIcon, ShieldXIcon, XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { SettingsNotice } from "./self-settings/settings-shell";
import {
  AdminAvatarError,
  adminAvatarReviewContentUrl,
  readAdminAvatarReviews,
  reviewAdminAvatar,
  withdrawAdminAvatar,
  type AdminAvatarReviewItem,
} from "./self-settings/avatar-api";

const STATES = ["PENDING", "APPROVED", "REJECTED", "QUARANTINED"] as const;
type State = typeof STATES[number];
type Action = { kind: "APPROVE" | "REJECT" | "QUARANTINE" | "WITHDRAW"; item: AdminAvatarReviewItem } | null;

export function AvatarReviewView({ snapshot, refreshNonce }: { snapshot: { adminUserId: string; security: { isBoss: boolean }; permissions: string[] }; refreshNonce: number }) {
  const allowed = snapshot.security.isBoss || snapshot.permissions.includes("profile.avatar.review");
  const [state, setState] = useState<State>("PENDING");
  const [items, setItems] = useState<AdminAvatarReviewItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [expectedRevision, setExpectedRevision] = useState("");

  const load = async (append = false) => {
    if (!allowed) { setLoading(false); return; }
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const page = await readAdminAvatarReviews(state, append ? nextCursor : null);
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      setError(messageOf(failure, "头像审核列表读取失败"));
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [state, refreshNonce, allowed]);

  const openAction = (item: AdminAvatarReviewItem, kind: NonNullable<Action>["kind"]) => {
    setAction({ item, kind });
    setReason("");
    setExpectedRevision(item.revision);
    setError("");
  };

  const submit = async () => {
    if (!action || busy) return;
    if (action.kind !== "APPROVE" && reason.trim().length < 2) { setError("请填写至少 2 个字符的原因。"); return; }
    setBusy(true);
    setError("");
    try {
      const key = `avatar-review-${action.kind.toLowerCase()}-${crypto.randomUUID()}`;
      if (action.kind === "WITHDRAW") await withdrawAdminAvatar(action.item.assetId, reason.trim(), expectedRevision || null, key);
      else await reviewAdminAvatar(action.item.assetId, action.kind, reason.trim() || null, expectedRevision || null, key);
      setAction(null);
      setNotice(action.kind === "APPROVE" ? "已通过；若仍是最新提交，头像已生效。" : action.kind === "WITHDRAW" ? "已撤回公开读取；如为当前头像则回退默认头像。" : "已记录审核结果，当前头像不受影响。");
      await load();
    } catch (failure) {
      setError(messageOf(failure, "审核操作未完成"));
    } finally {
      setBusy(false);
    }
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
        <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading || loadingMore}><RefreshCw />刷新</Button>
      </div>
      {error ? <SettingsNotice tone="danger" role="alert">{error}</SettingsNotice> : null}
      {notice ? <SettingsNotice tone="success" role="status">{notice}</SettingsNotice> : null}

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1" role="tablist" aria-label="审核状态">
        {STATES.map((value) => (
          <button key={value} type="button" role="tab" aria-selected={state === value} onClick={() => { setState(value); setNextCursor(null); }}
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
                  <Button type="button" size="sm" onClick={() => openAction(item, "APPROVE")}><CheckIcon />通过</Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => openAction(item, "REJECT")}><XIcon />拒绝</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => openAction(item, "QUARANTINE")}><ShieldAlertIcon />隔离</Button>
                </div>
              ) : item.reviewState === "APPROVED" && item.accessClass === "PUBLIC_DISPLAY" ? (
                <div className="pt-1"><Button type="button" size="sm" variant="outline" onClick={() => openAction(item, "WITHDRAW")}><ShieldXIcon />撤回公开</Button></div>
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
                <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder={action.kind === "APPROVE" ? "可留空" : "说明拒绝、隔离或撤回的原因"} autoFocus />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">原审核版本（CAS）</span>
                <Input value={expectedRevision} onChange={(event) => setExpectedRevision(event.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="留空则不校验" />
                <span className="text-muted-foreground text-xs">默认使用列表中读取到的版本；并发审核时版本不符会被拒绝。</span>
              </label>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAction(null)} disabled={busy}>取消</Button>
                <Button type="button" onClick={() => void submit()} disabled={busy}>{busy ? "提交中…" : "确认"}</Button>
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
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
