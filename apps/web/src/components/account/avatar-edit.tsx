"use client";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Camera, RefreshCw, Upload, X } from "lucide-react";
import { useUserSession, publishUserSessionChange } from "@/components/session/user-session-provider";
import { createAvatarUploadIntent, ProfileAvatarError, readAvatarState, selectDefaultAvatar, uploadAvatar, type AvatarState } from "@/lib/profile-avatar-client";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export function AvatarEditEntry({ userId }: { userId: string }) {
  const session = useUserSession();
  const identity = `${userId}:${session.identityVersion}`;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AvatarState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [intent, setIntent] = useState<{ intentId: string; uploadToken: string; intentKey: string; uploadKey: string } | null>(null);
  const scope = useRef(identity);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scope.current = identity;
    sequence.current += 1;
    abort.current?.abort();
    setState(null);
    setError("");
    setNotice("");
    clearFile();
    setIntent(null);
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  useEffect(() => () => {
    abort.current?.abort();
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const current = () => scope.current === identity;
  const start = () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    return { id: ++sequence.current, signal: controller.signal };
  };
  const active = (id: number) => current() && sequence.current === id;

  function clearFile() {
    setFile(null);
    setPreview((value) => { if (value) URL.revokeObjectURL(value); return null; });
  }

  async function load() {
    const { id, signal } = start();
    setLoading(true);
    setError("");
    try {
      const next = await readAvatarState(signal);
      if (active(id)) setState(next);
    } catch (failure) {
      if (signal.aborted) return;
      if (active(id)) setError(messageOf(failure, "头像状态读取失败"));
    } finally {
      if (active(id)) setLoading(false);
    }
  }

  async function choosePreset(presetId: string) {
    if (!state || busy) return;
    if (state.current.kind === "DEFAULT" && state.current.presetId === presetId && !state.pending) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await selectDefaultAvatar(presetId, state.revision, `avatar-default-${crypto.randomUUID()}`);
      if (!current()) return;
      setState(next);
      setNotice("默认头像已保存，正在刷新页面头像。");
      publishUserSessionChange();
      session.revalidate();
    } catch (failure) {
      if (!current()) return;
      setError(messageOf(failure, "默认头像保存失败"));
      if (failure instanceof ProfileAvatarError && failure.status === 409) {
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
    if (!file || busy) return;
    if (!ALLOWED.has(file.type)) { setError("仅支持 JPEG、PNG 或 WebP 图片。"); return; }
    if (file.size <= 0 || file.size > MAX_BYTES) { setError("图片需大于 0 且不超过 10 MiB。"); return; }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let currentIntent = intent;
      if (!currentIntent) {
        const intentKey = `avatar-intent-${crypto.randomUUID()}`;
        const created = await createAvatarUploadIntent(file, intentKey);
        currentIntent = { ...created, intentKey, uploadKey: `avatar-upload-${crypto.randomUUID()}` };
        if (!current()) return;
        setIntent(currentIntent);
      }
      await uploadAvatar(currentIntent.intentId, currentIntent.uploadToken, file, currentIntent.uploadKey);
      if (!current()) return;
      clearFile();
      setIntent(null);
      setNotice("已提交审核。审核期间继续显示当前头像。");
      await load();
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof ProfileAvatarError && failure.status === 409 && /expired|used/i.test(failure.message)) {
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
    <>
      <button type="button" className="button quiet button--xs account-edit-profile" onClick={() => { setOpen(true); void load(); }}>
        <Camera size={13} aria-hidden="true" />
        <span>更换头像</span>
      </button>
      <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); else { abort.current?.abort(); clearFile(); setIntent(null); } }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="avatar-dialog" aria-describedby="avatar-dialog-description">
            <div className="avatar-dialog-head">
              <div>
                <Dialog.Title className="avatar-dialog-title">更换头像</Dialog.Title>
                <Dialog.Description id="avatar-dialog-description" className="avatar-dialog-desc">
                  默认头像即时生效；自定义头像上传后先审核，期间保留当前头像。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild><button type="button" className="avatar-dialog-close" aria-label="关闭头像设置"><X size={18} /></button></Dialog.Close>
            </div>

            {error ? <p className="avatar-dialog-alert" role="alert">{error}</p> : null}
            {!state && error ? <button type="button" className="button secondary" onClick={() => void load()} disabled={loading}>重新读取</button> : null}
            {notice ? <p className="avatar-dialog-notice" role="status">{notice}</p> : null}
            {loading && !state ? <p className="avatar-dialog-muted" role="status">正在读取头像状态…</p> : null}

            {state ? (
              <>
                <div className="avatar-current">
                  <span className="avatar-current-image">
                    {state.current.url ? <img src={state.current.url} alt="" /> : null}
                  </span>
                  <div>
                    <strong>当前头像</strong>
                    <p>{state.current.kind === "CUSTOM" ? "自定义头像（已审核）" : "默认头像"}</p>
                    {state.pending ? <p className="avatar-pending-label">新头像审核中，当前继续显示这张。</p> : null}
                  </div>
                  <button type="button" className="button secondary button--xs" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={12} />刷新</button>
                </div>

                {state.pending ? (
                  <div className="avatar-pending">
                    <img src={`/api/v1/profile/avatar/preview?v=${encodeURIComponent(state.pending.assetId)}`} alt="待审核头像预览" />
                    <span>审核中 · 提交于 {formatTime(state.pending.submittedAt)}</span>
                  </div>
                ) : review && (review.state === "REJECTED" || review.state === "QUARANTINED") ? (
                  <div className="avatar-review-result is-rejected" role="status">
                    <strong>{review.state === "REJECTED" ? "上次上传未通过审核" : "上次上传已隔离"}</strong>
                    <p>{review.reason ?? "未提供具体原因。"} 该次上传未生效。</p>
                  </div>
                ) : review?.state === "WITHDRAWN" ? (
                  <div className="avatar-review-result" role="status"><strong>先前的自定义头像已撤回</strong><p>{review.reason ?? "公开读取已停止，当前回退到默认头像。"}</p></div>
                ) : null}

                <fieldset className="avatar-preset-fieldset" disabled={busy}>
                  <legend>选择默认头像</legend>
                  <div className="avatar-preset-grid">
                    {state.presets.map((preset) => {
                      const selected = state.current.kind === "DEFAULT" && state.current.presetId === preset.presetId && !state.pending;
                      return (
                        <button
                          key={preset.presetId}
                          type="button"
                          className={`avatar-preset${selected ? " is-selected" : ""}`}
                          aria-pressed={selected}
                          onClick={() => void choosePreset(preset.presetId)}
                        >
                          <img src={preset.url} alt="" width={preset.width} height={preset.height} />
                          <span>{selected ? "当前头像" : "选择"}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="avatar-upload">
                  <div>
                    <strong>上传自定义头像</strong>
                    <p>JPEG / PNG / WebP，≤10 MiB。上传成功后进入审核，不改变当前头像。</p>
                  </div>
                  {preview ? <img className="avatar-upload-preview" src={preview} alt="待上传头像预览" /> : null}
                  <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { chooseFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
                  <div className="avatar-upload-actions">
                    <button type="button" className="button secondary" onClick={() => inputRef.current?.click()} disabled={busy}><Upload size={14} />选择图片</button>
                    {file ? <button type="button" className="button primary" onClick={() => void submitUpload()} disabled={busy}>{busy ? "上传中…" : intent ? "重试上传" : "上传并提交审核"}</button> : null}
                    {file ? <button type="button" className="button ghost" onClick={() => { clearFile(); setIntent(null); }} disabled={busy}>移除</button> : null}
                  </div>
                </div>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ProfileAvatarError) return error.requestId ? `${error.message}（请求编号 ${error.requestId}）` : error.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatTime(value: string | null): string {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { hour12: false });
}
