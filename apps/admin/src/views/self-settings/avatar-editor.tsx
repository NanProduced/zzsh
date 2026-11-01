import { useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, Upload } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/ui/avatar";
import { SettingsNotice } from "./settings-shell";
import { AdminAvatarError, adminAvatarPreviewUrl, assertAdminAvatarSubject, clearPendingAdminAvatar, createAdminAvatarUploadIntent, readAdminAvatarOperationResult, readAdminAvatarState, readPendingAdminAvatar, savePendingAdminAvatar, selectAdminDefaultAvatar, uploadAdminAvatar, type AdminAvatarState, type PendingAdminAvatar } from "./avatar-api";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
type EditorProps = { adminUserId: string; sessionId: string; fallbackInitial: string; disabledReason?: string; onSessionRefresh?: () => Promise<unknown> | unknown };
export function AdminAvatarEditor(props: EditorProps) {
  return <AvatarEditorBody key={props.adminUserId + ":" + props.sessionId} {...props} />;
}
function AvatarEditorBody({ adminUserId, fallbackInitial, disabledReason, onSessionRefresh }: EditorProps) {
  const [state, setState] = useState<AdminAvatarState | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<string | null>(null);
  const [intent, setIntent] = useState<{ intentId: string; uploadToken: string; uploadKey: string } | null>(null);
  const [pendingDefault, setPendingDefault] = useState<PendingAdminAvatar | null>(null), [storageBlocked, setStorageBlocked] = useState(false);
  const alive = useRef(true), writing = useRef(false), writeSequence = useRef(0), sequence = useRef(0);
  const readAbort = useRef<AbortController | null>(null), writeAbort = useRef<AbortController | null>(null), inputRef = useRef<HTMLInputElement>(null);
  const uploadCommand = useRef<{ file: File; intentKey: string; uploadKey: string; expectedRevision: string; intentId?: string; uploadToken?: string } | null>(null);
  const current = () => alive.current;
  const activeWrite = (id: number) => current() && writeSequence.current === id;
  const refreshSession = async () => { try { await onSessionRefresh?.(); } catch { if (current()) setNotice("头像已保存，但顶部资料刷新失败，请重新读取。"); } };
  const load = async (refreshGlobal = false) => {
    readAbort.current?.abort(); const controller = new AbortController(); readAbort.current = controller;
    const seq = ++sequence.current; setLoading(true); setError("");
    try {
      const next = await readAdminAvatarState(controller.signal); assertAdminAvatarSubject(next, adminUserId);
      if (!current() || sequence.current !== seq) return;
      setState(next); if (refreshGlobal) await refreshSession();
    } catch (failure) { if (!controller.signal.aborted && current() && sequence.current === seq) setError(messageOf(failure, "头像状态读取失败")); }
    finally { if (current() && sequence.current === seq) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true; void load();
    try { setPendingDefault(readPendingAdminAvatar(adminUserId, "default")); }
    catch (failure) { setStorageBlocked(true); setError(messageOf(failure, "原头像操作记录不可读")); }
    return () => { alive.current = false; sequence.current++; writeSequence.current++; readAbort.current?.abort(); writeAbort.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminUserId]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  function clearFile() { setFile(null); setPreview(null); }
  function beginWrite() {
    if (writing.current || disabledReason) return null;
    writing.current = true; setBusy(true); setError(""); setNotice("");
    const controller = new AbortController(); writeAbort.current = controller;
    return { id: ++writeSequence.current, signal: controller.signal };
  }
  function finishWrite(id: number) { if (activeWrite(id)) { writing.current = false; setBusy(false); } }
  function releaseDefault(command: PendingAdminAvatar) { clearPendingAdminAvatar(command); setPendingDefault(null); }
  async function recoverDefault() {
    const run = beginWrite(); if (!run) return;
    try {
      const command = readPendingAdminAvatar(adminUserId, "default"); if (!command) { setPendingDefault(null); return; }
      setPendingDefault(command);
      const receipt = await readAdminAvatarOperationResult(command, run.signal);
      if (!activeWrite(run.id)) return;
      if (receipt.receipt === "UNRESOLVED") { setNotice("原头像操作仍未确认，请稍后再读取；不会重复提交。"); return; }
      const next = await readAdminAvatarState(run.signal); assertAdminAvatarSubject(next, adminUserId);
      if (!activeWrite(run.id)) return;
      setState(next); releaseDefault(command);
      setNotice(receipt.responseStatus < 300 ? "原头像操作已确认，已读取当前状态。" : "原操作已被拒绝，可按当前状态重新选择。");
      await refreshSession();
    } catch (failure) { if (activeWrite(run.id)) setError(messageOf(failure, "原头像结果尚未确认")); }
    finally { finishWrite(run.id); }
  }
  async function choosePreset(presetId: string) {
    if (!state || busy || loading || disabledReason || storageBlocked) return;
    const run = beginWrite(); if (!run) return;
    let command: PendingAdminAvatar | null = null;
    try {
      const prior = readPendingAdminAvatar(adminUserId, "default");
      if (prior) { setPendingDefault(prior); setNotice("请先读取原头像操作结果。"); return; }
      command = { actorId: adminUserId, slot: "default", presetId, expectedRevision: state.revision, key: "admin-avatar-default-" + crypto.randomUUID() };
      savePendingAdminAvatar(command); setPendingDefault(command);
      const next = await selectAdminDefaultAvatar(presetId, state.revision, command.key, run.signal); assertAdminAvatarSubject(next, adminUserId);
      if (!activeWrite(run.id)) return;
      setState(next); setNotice("默认头像已保存。");
      try { releaseDefault(command); } catch (failure) { setNotice("头像已保存；本地记录待清理，请读取原操作结果。"); setError(messageOf(failure, "本地记录尚未清除")); }
      await refreshSession();
    } catch (failure) {
      if (!activeWrite(run.id)) return;
      if (command && failure instanceof AdminAvatarError && [400,401,403,404,409,413,415,422,429].includes(failure.status)) { try { releaseDefault(command); } catch { setPendingDefault(command); } }
      setError(messageOf(failure, "默认头像结果未确认，请读取原操作结果"));
      if (failure instanceof AdminAvatarError && failure.status === 409) await load(true);
    } finally { finishWrite(run.id); }
  }
  function chooseFile(next: File | null) {
    if (writing.current || disabledReason || pendingDefault || storageBlocked) return;
    setError(""); setNotice(""); setIntent(null); uploadCommand.current = null;
    setPreview(next ? URL.createObjectURL(next) : null); setFile(next);
  }
  async function submitUpload() {
    if (!state || !file || busy || disabledReason || pendingDefault || storageBlocked) return;
    if (!ALLOWED.has(file.type)) { setError("仅支持 JPEG、PNG 或 WebP 图片。"); return; }
    if (file.size <= 0 || file.size > MAX_BYTES) { setError("图片需大于 0 且不超过 10 MiB。"); return; }
    const run = beginWrite(); if (!run) return;
    try {
      let command = uploadCommand.current;
      if (!command || command.file !== file) { command = { file, expectedRevision: state.revision, intentKey: "admin-avatar-intent-" + crypto.randomUUID(), uploadKey: "admin-avatar-upload-" + crypto.randomUUID() }; uploadCommand.current = command; }
      if (!command.intentId || !command.uploadToken) {
        const created = await createAdminAvatarUploadIntent(file, command.intentKey, command.expectedRevision, run.signal);
        if (!activeWrite(run.id)) return;
        Object.assign(command, created); setIntent({ ...created, uploadKey: command.uploadKey });
      }
      await uploadAdminAvatar(command.intentId!, command.uploadToken!, file, command.uploadKey, run.signal);
      if (!activeWrite(run.id)) return;
      clearFile(); setIntent(null); uploadCommand.current = null;
      setNotice("已提交审核。审核期间继续显示当前头像。"); await load();
    } catch (failure) {
      if (!activeWrite(run.id)) return;
      if (failure instanceof AdminAvatarError && failure.status === 409) {
        setIntent(null); uploadCommand.current = null; await load();
        if (activeWrite(run.id)) setError("头像版本或上传准备已变化，已重读当前状态；请确认后再次提交。");
      } else setError(messageOf(failure, "上传未完成；重试保留原上传请求"));
    }
    finally { finishWrite(run.id); }
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
        <Button type="button" size="sm" variant="secondary" onClick={() => void load(true)} disabled={loading || busy}>
          <RefreshCw />刷新
        </Button>
      </div>

      {disabledReason ? <SettingsNotice tone="warning">{disabledReason}</SettingsNotice> : null}
      {error ? <SettingsNotice tone="danger" role="alert">{error}</SettingsNotice> : null}
      {storageBlocked ? <SettingsNotice tone="danger">原头像操作记录不可读，暂不能再次提交。</SettingsNotice> : null}
      {pendingDefault ? <SettingsNotice tone="warning"><p>上次头像选择结果待确认，请先读取原操作。</p><Button type="button" variant="secondary" disabled={busy || Boolean(disabledReason)} onClick={() => void recoverDefault()}>读取原头像结果</Button></SettingsNotice> : null}
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

          <fieldset className="space-y-2" disabled={busy || loading || Boolean(disabledReason) || Boolean(pendingDefault) || storageBlocked}>
            <legend className="text-sm font-medium">选择默认头像</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {state.presets.map((preset, index) => {
                const selected = state.current.kind === "DEFAULT" && state.current.presetId === preset.presetId && !state.pending;
                return (
                  <button key={preset.presetId} type="button" aria-pressed={selected} aria-label={`选择默认头像 ${index + 1}`} onClick={() => void choosePreset(preset.presetId)}
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
