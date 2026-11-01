import { useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, Upload } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import { SettingsNotice } from "./settings-shell";
import {
  AdminAvatarError,
  adminAvatarPreviewUrl,
  createAdminAvatarUploadIntent,
  readAdminAvatarState,
  selectAdminDefaultAvatar,
  uploadAdminAvatar,
  type AdminAvatarState,
} from "./avatar-api";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export function AdminAvatarEditor({
  adminUserId,
  sessionId,
  fallbackInitial,
  disabledReason,
  onSessionRefresh,
}: {
  adminUserId: string;
  sessionId: string;
  fallbackInitial: string;
  disabledReason?: string;
  onSessionRefresh?: () => Promise<unknown> | unknown;
}) {
  const [state, setState] = useState<AdminAvatarState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [intent, setIntent] = useState<{ intentId: string; uploadToken: string; uploadKey: string } | null>(null);
  const identity = useRef(`${adminUserId}:${sessionId}`);
  const sequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = () => identity.current === `${adminUserId}:${sessionId}`;
  const load = async () => {
    const seq = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await readAdminAvatarState();
      if (current() && sequence.current === seq) setState(next);
    } catch (failure) {
      if (current() && sequence.current === seq) setError(messageOf(failure, "头像状态读取失败"));
    } finally {
      if (current() && sequence.current === seq) setLoading(false);
    }
  };

  useEffect(() => {
    identity.current = `${adminUserId}:${sessionId}`;
    sequence.current += 1;
    setState(null);
    clearFile();
    setIntent(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminUserId, sessionId]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function clearFile() {
    setFile(null);
    setPreview((value) => { if (value) URL.revokeObjectURL(value); return null; });
  }

  async function choosePreset(presetId: string) {
    if (!state || busy || disabledReason) return;
    if (state.current.kind === "DEFAULT" && state.current.presetId === presetId && !state.pending) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await selectAdminDefaultAvatar(presetId, state.revision, `admin-avatar-default-${crypto.randomUUID()}`);
      if (!current()) return;
      setState(next);
      setNotice("默认头像已保存。");
      try { await onSessionRefresh?.(); } catch { setNotice("头像已保存，但顶部当前用户显示刷新失败；刷新页面后可见。"); }
    } catch (failure) {
      if (!current()) return;
      setError(messageOf(failure, "默认头像保存失败"));
      if (failure instanceof AdminAvatarError && failure.status === 409) {
        setNotice("头像已在其他设备变化，已重新读取当前状态。");
        await load();
      }
    } finally {
      if (current()) setBusy(false);
    }
  }

  function chooseFile(next: File | null) {
    setError("");
    setNotice("");
    setIntent(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(next ? URL.createObjectURL(next) : null);
    setFile(next);
  }

  async function submitUpload() {
    if (!file || busy || disabledReason) return;
    if (!ALLOWED.has(file.type)) { setError("仅支持 JPEG、PNG 或 WebP 图片。"); return; }
    if (file.size <= 0 || file.size > MAX_BYTES) { setError("图片需大于 0 且不超过 10 MiB。"); return; }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let nextIntent = intent;
      if (!nextIntent) {
        const created = await createAdminAvatarUploadIntent(file, `admin-avatar-intent-${crypto.randomUUID()}`);
        nextIntent = { ...created, uploadKey: `admin-avatar-upload-${crypto.randomUUID()}` };
        if (!current()) return;
        setIntent(nextIntent);
      }
      await uploadAdminAvatar(nextIntent.intentId, nextIntent.uploadToken, file, nextIntent.uploadKey);
      if (!current()) return;
      clearFile();
      setIntent(null);
      setNotice("已提交审核。审核期间继续显示当前头像。");
      await load();
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof AdminAvatarError && failure.status === 409 && /expired|used/i.test(failure.message)) {
        setIntent(null);
        setError("本次上传凭证已过期，请重新上传。");
      } else {
        setError(messageOf(failure, "上传未完成；当前头像未改变"));
      }
    } finally {
      if (current()) setBusy(false);
    }
  }

  const review = state?.lastReview;
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar className="size-16">
          {state?.current.url ? <AvatarImage src={state.current.url} alt="" /> : null}
          <AvatarFallback>{fallbackInitial}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">当前头像</div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {state?.current.kind === "CUSTOM" ? "自定义头像（已审核公开）" : "默认头像。默认头像即时生效；自定义头像先审后显。"}
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => void load()} disabled={loading || busy}>
          <RefreshCw />刷新
        </Button>
      </div>

      {disabledReason ? <SettingsNotice tone="warning">{disabledReason}</SettingsNotice> : null}
      {error ? <SettingsNotice tone="danger" role="alert">{error}</SettingsNotice> : null}
      {notice ? <SettingsNotice tone="success" role="status">{notice}</SettingsNotice> : null}
      {loading && !state ? <p className="text-muted-foreground text-sm" role="status">正在读取头像状态…</p> : null}

      {state ? (
        <>
          {state.pending ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3 text-xs" role="status">
              <img className="size-11 rounded-full object-cover" src={adminAvatarPreviewUrl(state.pending.assetId)} alt="待审核头像预览" />
              <span>新头像审核中，当前继续显示原头像。</span>
            </div>
          ) : review && (review.state === "REJECTED" || review.state === "QUARANTINED") ? (
            <SettingsNotice tone="danger" role="status">
              上次上传{review.state === "REJECTED" ? "未通过审核" : "已隔离"}：{review.reason ?? "未提供具体原因。"} 该次上传未生效。
            </SettingsNotice>
          ) : review?.state === "WITHDRAWN" ? (
            <SettingsNotice tone="warning" role="status">先前的自定义头像已撤回：{review.reason ?? "公开读取已停止，当前回退到默认头像。"}</SettingsNotice>
          ) : null}

          <fieldset className="space-y-2" disabled={busy || Boolean(disabledReason)}>
            <legend className="text-sm font-medium">选择默认头像</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {state.presets.map((preset) => {
                const selected = state.current.kind === "DEFAULT" && state.current.presetId === preset.presetId && !state.pending;
                return (
                  <button key={preset.presetId} type="button" aria-pressed={selected} onClick={() => void choosePreset(preset.presetId)}
                    className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent/60"}`}>
                    <img className="aspect-square w-full max-w-20 rounded-full object-cover" src={preset.url} alt="" width={preset.width} height={preset.height} />
                    <span>{selected ? "当前头像" : "选择"}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium"><Camera className="size-4" aria-hidden />上传自定义头像</div>
              <p className="text-muted-foreground mt-1 text-xs">JPEG / PNG / WebP，≤10 MiB。上传成功进入审核，期间不改变当前头像。</p>
            </div>
            {preview ? <img className="size-20 rounded-full border border-border object-cover" src={preview} alt="待上传头像预览" /> : null}
            <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { chooseFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy || Boolean(disabledReason)}><Upload />选择图片</Button>
              {file ? <Button type="button" size="sm" onClick={() => void submitUpload()} disabled={busy || Boolean(disabledReason)}>{busy ? "上传中…" : intent ? "重试上传" : "上传并提交审核"}</Button> : null}
              {file ? <Button type="button" size="sm" variant="ghost" onClick={() => { clearFile(); setIntent(null); }} disabled={busy}>移除</Button> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof AdminAvatarError) return error.requestId ? `${error.message}（请求编号 ${error.requestId}）` : error.message;
  return error instanceof Error && error.message ? error.message : fallback;
}
