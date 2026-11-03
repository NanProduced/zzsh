"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Camera, Check, RefreshCw, Upload, X } from "lucide-react";
import { AvatarCropper } from "@zzsh/ui/avatar-crop";
import "@zzsh/ui/avatar-crop.css";
import { useUserSession, publishUserSessionChange, publishProfileUpdateNotice, dismissProfileUpdateNotice } from "@/components/session/user-session-provider";
import { assertAvatarSubject, clearPendingAvatarDefault, createAvatarUploadIntent, parseAvatarReceipt, ProfileAvatarError, readAvatarOperationResult, readAvatarState, readPendingAvatarDefault, savePendingAvatarDefault, selectDefaultAvatar, uploadAvatar, type AvatarState, type PendingAvatarDefault } from "@/lib/profile-avatar-client";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export function AvatarEditEntry({ userId, children }: { userId: string; children?: ReactNode }) {
  const session = useUserSession();
  return <AvatarEditor key={`${userId}:${session.identityVersion}`} userId={userId} session={session} avatar={children} />;
}
function AvatarEditor({ userId, session, avatar }: { userId: string; session: ReturnType<typeof useUserSession>; avatar?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'default' | 'upload'>('default');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<File | null>(null);
  const [state, setState] = useState<AvatarState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingDefault, setPendingDefault] = useState<PendingAvatarDefault | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [intent, setIntent] = useState<{ intentId: string; uploadToken: string; intentKey: string; uploadKey: string } | null>(null);
  const uploadCommand = useRef<{ file: File; intentKey: string; uploadKey: string; expectedRevision: string; intentId?: string; uploadToken?: string } | null>(null);
  const alive = useRef(true), writing = useRef(false), writeSequence = useRef(0);
  const sequence = useRef(0), abort = useRef<AbortController | null>(null), writeAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const current = () => alive.current;

  useEffect(() => {
    alive.current = true;
    try { setPendingDefault(readPendingAvatarDefault(userId)); }
    catch (failure) { setStorageBlocked(true); setError(messageOf(failure, "原头像操作不可读")); }
    return () => { alive.current = false; sequence.current++; writeSequence.current++; abort.current?.abort(); writeAbort.current?.abort(); };
  }, [userId]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function clearFile() { setFile(null); setPreview(null); }
  function cancelWork() {
    sequence.current++; writeSequence.current++;
    abort.current?.abort(); writeAbort.current?.abort();
    writing.current = false; setBusy(false); setLoading(false);
    setCropSource(null); setSelectedPreset(null);
    // An unresolved upload keeps its original file/keys across a closed dialog; closing is not a withdrawal.
    if (!uploadCommand.current) { clearFile(); setIntent(null); }
  }
  function beginWrite() {
    if (writing.current) return null;
    writing.current = true; setBusy(true); setError(""); setNotice("");
    const controller = new AbortController(); writeAbort.current = controller;
    return { id: ++writeSequence.current, signal: controller.signal };
  }
  const activeWrite = (id: number) => current() && writeSequence.current === id;
  function finishWrite(id: number) { if (activeWrite(id)) { writing.current = false; setBusy(false); } }
  const refreshSession = () => { publishUserSessionChange(); session.revalidate(); };
  function releaseDefault(command: PendingAvatarDefault) {
    clearPendingAvatarDefault(command); setPendingDefault(null);
  }
  async function load(refreshGlobal = false) {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const id = ++sequence.current; setLoading(true); setError("");
    try {
      const next = await readAvatarState(controller.signal); assertAvatarSubject(next, userId);
      if (current() && sequence.current === id) { setState(next); if (refreshGlobal) refreshSession(); }
    } catch (failure) { if (!controller.signal.aborted && current() && sequence.current === id) setError(messageOf(failure, "头像状态读取失败")); }
    finally { if (current() && sequence.current === id) setLoading(false); }
  }
  async function recoverDefault() {
    const run = beginWrite(); if (!run) return;
    try {
      const command = readPendingAvatarDefault(userId); if (!command) { setPendingDefault(null); return; }
      setPendingDefault(command);
      const receipt = parseAvatarReceipt(await readAvatarOperationResult(command.key, command.presetId, command.expectedRevision, run.signal));
      if (!activeWrite(run.id)) return;
      if (receipt.receipt === "UNRESOLVED") { setNotice("原操作结果仍未确认，请稍后再次读取；不会重复提交。"); return; }
      const next = await readAvatarState(run.signal); assertAvatarSubject(next, userId);
      if (!activeWrite(run.id)) return;
      setState(next); releaseDefault(command);
      setNotice(receipt.responseStatus < 300 ? "原头像操作已确认，已读取当前状态。" : "原操作已被拒绝，已读取当前状态，可重新选择。");
      if (receipt.responseStatus < 300) refreshSession();
    } catch (failure) { if (activeWrite(run.id)) setError(messageOf(failure, "原头像结果尚未确认")); }
    finally { finishWrite(run.id); }
  }
  async function choosePreset(presetId: string) {
    if (!state || busy || loading || storageBlocked) return;
    const run = beginWrite(); if (!run) return;
    let command: PendingAvatarDefault | null = null;
    try {
      const prior = readPendingAvatarDefault(userId);
      if (prior) { setPendingDefault(prior); setNotice("请先读取原头像操作结果。"); return; }
      command = { userId, presetId, expectedRevision: state.revision, key: `avatar-default-${crypto.randomUUID()}` };
      savePendingAvatarDefault(command); setPendingDefault(command);
      const next = await selectDefaultAvatar(presetId, state.revision, command.key, run.signal); assertAvatarSubject(next, userId);
      if (!activeWrite(run.id)) return;
      setState(next); publishProfileUpdateNotice(userId, 'avatar'); refreshSession();
      try { releaseDefault(command); clearFile(); setCropSource(null); setNotice("默认头像已保存，正在刷新页面头像。"); setOpen(false); }
      catch (failure) { setNotice("默认头像已保存；本地记录待清理，请读取原操作结果。"); setError(messageOf(failure, "本地记录尚未清除")); }
    } catch (failure) {
      if (!activeWrite(run.id)) return;
      if (command && failure instanceof ProfileAvatarError && [400,401,403,404,409,413,415,422,429].includes(failure.status)) {
        try { releaseDefault(command); } catch { setPendingDefault(command); }
      }
      setError(messageOf(failure, "默认头像结果未确认，请读取原操作结果"));
      if (failure instanceof ProfileAvatarError && failure.status === 409) await load();
    } finally { finishWrite(run.id); }
  }
  function chooseFile(next: File | null) {
    if (!next || writing.current || pendingDefault || storageBlocked || uploadCommand.current) return;
    setError(''); setNotice('');
    if (!ALLOWED.has(next.type) || next.size <= 0 || next.size > MAX_BYTES) { setError('请选择不超过 10 MiB 的 JPEG、PNG 或 WebP 图片。'); return; }
    setCropSource(next);
  }
  async function submitUpload() {
    if (!state || !file || busy || pendingDefault || storageBlocked) return;
    if (!ALLOWED.has(file.type)) { setError("仅支持 JPEG、PNG 或 WebP 图片。"); return; }
    if (file.size <= 0 || file.size > MAX_BYTES) { setError("图片需大于 0 且不超过 10 MiB。"); return; }
    const run = beginWrite(); if (!run) return;
    try {
      let command = uploadCommand.current;
      if (!command || command.file !== file) { command = { file, expectedRevision: state.revision, intentKey: `avatar-intent-${crypto.randomUUID()}`, uploadKey: `avatar-upload-${crypto.randomUUID()}` }; uploadCommand.current = command; }
      if (!command.intentId || !command.uploadToken) {
        const created = await createAvatarUploadIntent(file, command.intentKey, command.expectedRevision, run.signal);
        if (!activeWrite(run.id)) return;
        Object.assign(command, created); setIntent({ ...created, intentKey: command.intentKey, uploadKey: command.uploadKey });
      }
      await uploadAvatar(command.intentId!, command.uploadToken!, file, command.uploadKey, run.signal);
      if (!activeWrite(run.id)) return;
      clearFile(); setIntent(null); uploadCommand.current = null;
      setNotice("已提交审核。审核期间继续显示当前头像。"); await load();
    } catch (failure) {
      if (!activeWrite(run.id)) return;
      if (failure instanceof ProfileAvatarError && failure.status === 409) {
        setIntent(null); uploadCommand.current = null; await load();
        if (activeWrite(run.id)) setError("头像版本或上传准备已变化，已重读当前状态；请确认后再次提交。");
      } else setError(messageOf(failure, "上传未完成；重试保留原上传请求"));
    }
    finally { finishWrite(run.id); }
  }
  const review = state?.lastReview;
  return (
    <>
      <button ref={triggerRef} type="button" className="account-avatar-control" aria-label="更换头像" onClick={() => { dismissProfileUpdateNotice(userId); setSelectedPreset(null); setTab(uploadCommand.current ? 'upload' : 'default'); setOpen(true); void load(); }}>
        {avatar ?? <span className="account-growth-avatar" aria-hidden>{session.avatarUrl ? <img src={session.avatarUrl} alt=""/> : <Camera size={24}/>}</span>}
        <span className="account-avatar-camera" aria-hidden><Camera size={16}/></span>
      </button>
      <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); else cancelWork() }}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="avatar-dialog" aria-describedby="avatar-dialog-description" onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}>
            <div className="avatar-dialog-head">
              <div>
                <Dialog.Title className="avatar-dialog-title">更换头像</Dialog.Title>
                <Dialog.Description id="avatar-dialog-description" className="sr-only">
                  选择默认头像，或上传并裁剪图片。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild><button type="button" className="avatar-dialog-close" aria-label="关闭头像设置"><X size={18} /></button></Dialog.Close>
            </div>

            {error ? <p className="avatar-dialog-alert" role="alert">{error}</p> : null}
            {storageBlocked ? <p className="avatar-dialog-alert" role="alert">原头像操作记录不可读，暂不能再次提交。</p> : null}
            {!state && error ? <button type="button" className="button secondary" onClick={() => void load()} disabled={loading}>重新读取</button> : null}
            {notice ? <p className="avatar-dialog-notice" role="status">{notice}</p> : null}
            {pendingDefault ? <div className="avatar-dialog-notice" role="status"><p>上次头像选择结果待确认，请先读取原操作。</p><button type="button" className="button secondary" disabled={busy} onClick={() => void recoverDefault()}>读取原头像结果</button></div> : null}
            {loading && !state ? <p className="avatar-dialog-muted" role="status">正在读取头像状态…</p> : null}

            {state ? (
              <>
                <div className="avatar-dialog-tabs" role="group" aria-label="头像来源">
                  <button type="button" aria-pressed={tab === 'default'} disabled={busy} onClick={() => setTab('default')}>默认头像</button>
                  <button type="button" aria-pressed={tab === 'upload'} disabled={busy} onClick={() => setTab('upload')}>上传图片</button>
                </div>
                {state.pending ? (
                  <div className="avatar-pending">
                    <img src={`/api/v1/profile/avatar/preview?v=${encodeURIComponent(state.pending.assetId)}`} alt="待审核头像预览" />
                    <span>新头像审核中 · {formatTime(state.pending.submittedAt)}（北京时间）</span>
                    <button type="button" className="button quiet button--xs" onClick={() => void load(true)} disabled={loading || busy}><RefreshCw size={12}/>刷新审核状态</button>
                  </div>
                ) : review && (review.state === "REJECTED" || review.state === "QUARANTINED") ? (
                  <div className="avatar-review-result is-rejected" role="status">
                    <strong>{review.state === "REJECTED" ? "上次上传未通过审核" : "上次上传已隔离"}</strong>
                    <p>{review.reason ?? "未提供具体原因。"} 该次上传未生效。</p>
                  </div>
                ) : review?.state === "WITHDRAWN" ? (
                  <div className="avatar-review-result" role="status"><strong>先前的自定义头像已撤回</strong><p>{review.reason ?? "公开读取已停止，当前回退到默认头像。"}</p></div>
                ) : null}

                {tab === 'default' ? <><div className="avatar-selection-preview"><img src={state.presets.find(item => item.presetId === selectedPreset)?.url ?? state.current.url} alt="所选头像预览"/></div>
                <fieldset className="avatar-preset-fieldset" disabled={busy || loading || Boolean(pendingDefault) || storageBlocked || Boolean(uploadCommand.current)}>
                  <legend className="sr-only">选择默认头像</legend>
                  <div className="avatar-preset-grid">
                    {state.presets.map((preset, index) => {
                      const selected = (selectedPreset ?? (state.current.kind === 'DEFAULT' ? state.current.presetId : null)) === preset.presetId;
                      return (
                        <button
                          key={preset.presetId}
                          type="button"
                          className={`avatar-preset${selected ? " is-selected" : ""}`}
                          aria-pressed={selected}
                          aria-label={`选择默认头像 ${index + 1}`}
                          onClick={() => { setSelectedPreset(preset.presetId); setError(''); setNotice(''); }}
                        >
                          <img src={preset.url} alt="" width={preset.width} height={preset.height} />
                          {selected ? <span className="avatar-preset-mark" aria-hidden><Check size={12}/></span> : null}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
                {state.pending ? <p className="avatar-dialog-muted">改用默认头像后，将以本次选择为准。</p> : null}
                <div className="avatar-dialog-actions"><button type="button" className="button secondary" onClick={() => { setOpen(false); cancelWork(); }}>取消</button><button type="button" className="button primary" disabled={busy || loading || storageBlocked || Boolean(pendingDefault) || Boolean(uploadCommand.current) || !selectedPreset || selectedPreset === state.current.presetId && !state.pending} onClick={() => selectedPreset && void choosePreset(selectedPreset)}>{busy ? '正在保存…' : '使用此头像'}</button></div></> : cropSource ? <AvatarCropper file={cropSource} onCancel={() => setCropSource(null)} onConfirm={cropped => { setFile(cropped); setPreview(URL.createObjectURL(cropped)); setCropSource(null); }} /> : <div className="avatar-upload">
                  {preview ? <><img className="avatar-upload-preview" src={preview} alt="待上传头像预览"/><p className="avatar-upload-policy">审核通过后生效，期间保留原头像。</p></> : <button type="button" className="avatar-upload-dropzone" aria-label="选择图片" disabled={busy || Boolean(pendingDefault) || storageBlocked || Boolean(uploadCommand.current)} onClick={() => inputRef.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!writing.current && event.dataTransfer.files.length !== 1) setError('每次请选择一张图片。'); else chooseFile(event.dataTransfer.files[0] ?? null); }}><Upload size={28} aria-hidden/><strong>选择图片</strong><span>或将图片拖到这里</span></button>}
                  {!file ? <p className="avatar-upload-format">JPEG、PNG、WebP · 最大 10 MiB</p> : null}
                  <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { chooseFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
                  <div className="avatar-upload-actions">
                    {file ? <button type="button" className="button secondary" onClick={() => inputRef.current?.click()} disabled={busy || Boolean(pendingDefault) || storageBlocked || Boolean(uploadCommand.current)}>重新选择</button> : null}
                    {file ? <button type="button" className="button primary" onClick={() => void submitUpload()} disabled={busy}>{busy ? "上传中…" : intent ? "重试上传" : "上传并提交审核"}</button> : null}
                    <button type="button" className="button quiet" onClick={() => { setOpen(false); cancelWork(); }}>取消</button>
                  </div>
                </div>}
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
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { timeZone: 'Asia/Shanghai', hour12: false });
}
