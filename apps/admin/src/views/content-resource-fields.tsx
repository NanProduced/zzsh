import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Crop, ImagePlus } from "lucide-react";
import type { ResourceDefinition } from "@zzsh/content";
import { adminRequest, friendlyError, type ContentMediaOption, type ContentMediaOptionsPage, type UploadedAssetResponse } from "../api";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { ContentImage, ContentMediaFileField, contentMediaFileIssue, contentMediaUrl, uploadContentMedia } from "./content-media-upload";
import { ContentImageAdjust, type ContentImageSource } from "./content-image-adjust";
import "./content-media.css";

export function ContentField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <Field label={label} hint={hint}>{children}</Field>;
}
export function ContentSelect({ value, onChange, options, disabled, ariaLabel, className = "" }: {
  value: string; onChange: (value: string) => void; options: readonly { value: string; label: string }[]; disabled?: boolean; ariaLabel: string; className?: string;
}) {
  return <Select value={value} items={options.map(option => ({ ...option }))} onValueChange={next => { if (next !== null) onChange(String(next)); }} disabled={disabled}>
    <SelectTrigger aria-label={ariaLabel} className={`h-9 w-full text-sm ${className}`}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
export function ContentText({ label, value, onChange, max = 200, multiline = false }: { label: string; value: string; onChange: (value: string) => void; max?: number; multiline?: boolean }) {
  const count = [...value.normalize("NFC").replace(/\r\n?/g, "\n")].length;
  return <Field label={label} error={count > max ? `最多 ${max} 字符，当前 ${count} 字符。` : undefined}>
    {multiline ? <Textarea value={value} onChange={event => onChange(event.target.value)} /> : <Input value={value} onChange={event => onChange(event.target.value)} />}
  </Field>;
}

export function ContentMediaField({ label, value, onChange, hint, disabled = false, canUpload = false, canReview = false, allowClear = false, showPreview = true, onSelected, validateOption, pickerOnly = false, clearLabel = "使用桌面图片", buttonLabel, emptyLabel, definition, acceptedMime }: {
  label: string; value: string | null; onChange: (id: string | null) => void; hint: string; disabled?: boolean;
  canUpload?: boolean; canReview?: boolean; allowClear?: boolean; showPreview?: boolean; onSelected?: (option: ContentMediaOption) => void; validateOption?: (option: ContentMediaOption) => string | undefined; pickerOnly?: boolean; clearLabel?: string; buttonLabel?: string; emptyLabel?: string; definition?: ResourceDefinition | null; acceptedMime?: "image/png";
}) {
  const [open, setOpen] = useState(false), [options, setOptions] = useState<ContentMediaOption[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false), [listError, setListError] = useState<string>();
  const [mode, setMode] = useState<"library" | "upload">("library"), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [file, setFile] = useState<File | null>(null), [uploaded, setUploaded] = useState<UploadedAssetResponse | null>(null);
  const [localSize, setLocalSize] = useState<{ file: File; width: number; height: number } | null>(null);
  const [adjustSource, setAdjustSource] = useState<ContentImageSource | null>(null);
  const sequence = useRef(0), alive = useRef(true), committing = useRef(false);
  const approvalKey = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current; }; }, []);
  const load = useCallback(async (next: string | null) => {
    const seq = ++sequence.current; setLoading(true); setListError(undefined);
    try {
      const query = new URLSearchParams({ limit: "20", ...(next ? { cursor: next } : {}) });
      const page = await adminRequest<ContentMediaOptionsPage>(`/content/media-options?${query}`);
      if (seq === sequence.current && alive.current) { setOptions(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); }
    } catch (failure) { if (seq === sequence.current && alive.current) setListError(friendlyError(failure)); }
    finally { if (seq === sequence.current && alive.current) setLoading(false); }
  }, []);
  useEffect(() => { if (open || pickerOnly) void load(null); }, [load, open, pickerOnly]);
  const select = (option: ContentMediaOption) => {
    const issue = validateOption?.(option);
    if (issue) {
      if (canUpload && !disabled) { setError(undefined); setAdjustSource({ url: contentMediaUrl(option.id) }); }
      else setError(issue);
      return;
    }
    setError(undefined);
    onSelected?.(option);
    onChange(option.id);
    setOpen(false);
  };
  const fileIssue = file && (contentMediaFileIssue(file, acceptedMime) || (definition && (file !== localSize?.file ? "正在确认图片尺寸…" :
    validateOption?.({ ...localSize, id: "", mime: file.type, byteSize: String(file.size) }))));
  const upload = async () => {
    if (!file || fileIssue || committing.current || disabled || !canUpload) return;
    committing.current = true; setBusy(true); setError(undefined);
    try {
      const result = await uploadContentMedia(file);
      if (alive.current) { approvalKey.current = undefined; setUploaded(result); setFile(null); }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : friendlyError(failure)); }
    finally { committing.current = false; if (alive.current) setBusy(false); }
  };
  const uploadedOption = uploaded ? { id: uploaded.assetId, mime: uploaded.mime, width: uploaded.width, height: uploaded.height, byteSize: String(uploaded.byteSize) } : null;
  const uploadedIssue = uploadedOption ? (acceptedMime && uploadedOption.mime !== acceptedMime ? "请选择 PNG 图片。" : validateOption?.(uploadedOption)) : undefined;
  const approve = async () => {
    if (!uploadedOption || uploadedIssue || committing.current || !canReview || disabled) return;
    committing.current = true; setBusy(true); setError(undefined);
    try {
      const key = approvalKey.current ??= `idem_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = await adminRequest<{ id: string; reviewState: string; accessClass: string }>(`/content/media/${encodeURIComponent(uploadedOption.id)}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, "POST", { "idempotency-key": key });
      if (!alive.current) return;
      if (result?.id !== uploadedOption.id || result.reviewState !== "APPROVED" || result.accessClass !== "PUBLIC_DISPLAY") {
        setError("暂时无法确认审核结果。请重试确认，或到图片素材查看。");
        return;
      }
      setUploaded(null);
      setMode("library");
      select(uploadedOption);
    } catch (failure) { if (alive.current) setError(friendlyError(failure)); }
    finally { committing.current = false; if (alive.current) setBusy(false); }
  };
  const showUpload = canUpload && mode === "upload";
  const eligibleOptions = acceptedMime ? options.filter(option => option.mime === acceptedMime) : options;
  const picker = adjustSource ? <ContentImageAdjust source={adjustSource} definition={definition} outputMime={acceptedMime}
    onCancel={() => setAdjustSource(null)} onApply={next => { setAdjustSource(null); setUploaded(null); setFile(next); setError(undefined); setMode("upload"); }} />
    : <div className="content-image-picker">
    {canUpload ? <div className="content-image-picker-modes" role="group" aria-label="图片来源">
      <Button type="button" size="sm" variant={showUpload ? "ghost" : "secondary"} aria-pressed={!showUpload} disabled={busy} onClick={() => { setMode("library"); setError(undefined); void load(null); }}>从图片素材选</Button>
      <Button type="button" size="sm" variant={showUpload ? "secondary" : "ghost"} aria-pressed={showUpload} disabled={busy} onClick={() => { setMode("upload"); setError(undefined); }}>上传新图</Button>
    </div> : null}
    {showUpload ? <div className="space-y-3">
      {!uploadedOption ? <>
        <p className="text-sm text-muted-foreground">{canReview ? "上传后确认图片无误，再审核并使用。" : "上传后由有审核权限的同事处理，通过后即可在这里选择。"}</p>
        <ContentMediaFileField file={file} acceptedMime={acceptedMime} disabled={disabled || busy} onChange={next => { setFile(next); setError(undefined); }} onAdjust={() => setAdjustSource(file)}
          onDimensions={definition ? (source, size) => setLocalSize({ file: source, ...size }) : undefined} />
        {file && !contentMediaFileIssue(file) && fileIssue ? <p className="text-xs text-muted-foreground" role="status">{fileIssue}</p> : null}
        <Button type="button" disabled={!file || Boolean(fileIssue) || disabled} loading={busy} onClick={() => void upload()}>上传图片</Button>
      </> : <>
        <div className="content-file-preview"><ContentImage src={contentMediaUrl(uploadedOption.id)} alt="刚上传的图片" /></div>
        <p className="text-sm" role="status">已存入图片素材，等待审核。</p>
        {uploadedIssue ? <p className="text-sm text-destructive" role="alert">{uploadedIssue} 已上传的图片仍可在图片素材中处理。</p> : null}
        {!canReview ? <p className="text-xs text-muted-foreground">审核通过后，在「从图片素材选」里找到它。</p> : null}
        <div className="flex flex-wrap gap-2">
          {canReview && !uploadedIssue ? <Button type="button" disabled={disabled} loading={busy} onClick={() => void approve()}>审核通过并使用</Button> : null}
          {uploadedIssue ? <Button type="button" disabled={busy || disabled} onClick={() => setAdjustSource({ url: contentMediaUrl(uploadedOption.id) })}>调整尺寸再用</Button> : null}
          <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => { setUploaded(null); setError(undefined); }}>上传另一张</Button>
        </div>
      </>}
    </div> : <div className="space-y-3">
      <p className="text-sm text-muted-foreground">从审核通过、可供用户查看的图片中选择。</p>
      {listError ? <StatusMessage error={listError} /> : null}
      <div className="content-image-options">{eligibleOptions.map(option => {
        const issue = validateOption?.(option);
        return <div className="content-image-tile" key={option.id}>
          <button type="button" disabled={disabled || busy} className="content-image-option"
            aria-label={`${issue && canUpload ? "调整" : "选择"} ${option.width} × ${option.height} 图片`} aria-pressed={option.id === value} onClick={() => select(option)}>
            <span className="content-image-option-preview"><ContentImage src={contentMediaUrl(option.id)} alt="" lazy /></span>
            <span className="content-image-option-label">{option.width} × {option.height}{option.id === value ? " · 已选" : issue ? canUpload ? " · 需调整" : " · 尺寸不符" : ""}</span>
          </button>
          {canUpload && !issue ? <Button type="button" variant="ghost" size="xs" disabled={busy || disabled} onClick={() => setAdjustSource({ url: contentMediaUrl(option.id) })}><Crop size={13} aria-hidden="true" />调整后使用</Button> : null}
        </div>;
      })}</div>
      {!loading && !listError && !eligibleOptions.length ? <div className="content-media-empty">{cursor ? "本页没有符合条件的图片，可继续加载更多。" : "暂时没有可用图片。"}{canUpload ? "可以在这里上传新图。" : "请联系有权限的同事在「图片素材」上传并审核。"}</div> : null}
      {loading ? <p className="text-sm text-muted-foreground" role="status">正在读取图片…</p> : null}
      {listError || cursor ? <Button type="button" size="sm" variant="secondary" disabled={loading || disabled} onClick={() => void load(listError ? null : cursor)}>{listError ? "重试" : "加载更多图片"}</Button> : null}
    </div>}
    {error ? <StatusMessage error={error} /> : null}
  </div>;
  if (pickerOnly) return picker;
  return <div className="content-media-field">
    <div className="content-picture-heading"><div className="min-w-0"><p className="text-sm font-medium">{label}</p>{hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}</div>
      {!disabled ? <div className="flex flex-wrap items-center gap-1">
        {value && allowClear ? <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>{clearLabel}</Button> : null}
        <Button type="button" size="sm" variant="secondary" onClick={() => { setError(undefined); setAdjustSource(null); setMode("library"); setOpen(true); }}><ImagePlus size={14} aria-hidden="true" />{buttonLabel ?? (value ? "更换图片" : "选择图片")}</Button>
      </div> : null}
    </div>
    {showPreview ? value ? <div className="content-picture-preview"><ContentImage src={contentMediaUrl(value)} alt={`${label}预览`} /></div>
      : <p className="content-picture-unset">{emptyLabel ?? (allowClear ? "未单独设置，使用桌面图片。" : "尚未选择图片。")}</p> : null}
    <Dialog open={open} onOpenChange={next => { if (!next && !committing.current) setOpen(false); }}>
      <DialogContent size="md" className="content-picture-picker-dialog" showCloseButton={!busy} closeLabel="关闭选图">
        <DialogTitle>选择{label.includes("二维码") ? "二维码" : "图片"}</DialogTitle>
        <DialogDescription>{hint || "可以使用图片素材，也可以上传新图。"}</DialogDescription>
        <div className="content-picture-picker-body">{picker}</div>
      </DialogContent>
    </Dialog>
  </div>;
}
