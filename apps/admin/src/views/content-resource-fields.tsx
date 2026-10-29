import { useEffect, useRef, useState, type ReactNode } from "react";
import { ImagePlus, Upload } from "lucide-react";
import { adminRequest, friendlyError, type ContentMediaOption, type ContentMediaOptionsPage, type UploadedAssetResponse } from "../api";
import { Button, StatusMessage } from "../components/ui-elements";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { uploadContentMedia } from "./content-media-tab";

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

export function ContentMediaField({ label, value, onChange, hint, disabled = false, canUpload = false, canReview = false, allowClear = false, showPreview = true, onSelected, validateOption }: {
  label: string; value: string | null; onChange: (id: string | null) => void; hint: string; disabled?: boolean;
  canUpload?: boolean; canReview?: boolean; allowClear?: boolean; showPreview?: boolean; onSelected?: (option: ContentMediaOption) => void; validateOption?: (option: ContentMediaOption) => string | undefined;
}) {
  const [open, setOpen] = useState(false), [options, setOptions] = useState<ContentMediaOption[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [file, setFile] = useState<File | null>(null), [uploaded, setUploaded] = useState<UploadedAssetResponse | null>(null);
  const sequence = useRef(0), alive = useRef(true), committing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current; }; }, []);
  const load = async (next: string | null) => {
    const seq = ++sequence.current; setBusy(true); setError(undefined);
    try {
      const query = new URLSearchParams({ limit: "20", ...(next ? { cursor: next } : {}) });
      const page = await adminRequest<ContentMediaOptionsPage>(`/content/media-options?${query}`);
      if (seq === sequence.current && alive.current) { setOptions(previous => next ? [...previous, ...page.items] : page.items); setCursor(page.nextCursor); }
    } catch (failure) { if (seq === sequence.current && alive.current) setError(friendlyError(failure)); }
    finally { if (seq === sequence.current && alive.current) setBusy(false); }
  };
  const upload = async () => {
    if (!file || committing.current || disabled) return;
    committing.current = true; setBusy(true); setError(undefined);
    try { const result = await uploadContentMedia(file); if (alive.current) { setUploaded(result); setFile(null); } }
    catch (failure) { if (alive.current) setError(friendlyError(failure)); }
    finally { committing.current = false; if (alive.current) setBusy(false); }
  };
  const approve = async () => {
    if (!uploaded || committing.current || !canReview || disabled) return;
    committing.current = true; setBusy(true); setError(undefined);
    try {
      await adminRequest(`/content/media/${encodeURIComponent(uploaded.assetId)}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" });
      if (alive.current) { setUploaded(null); await load(null); }
    } catch (failure) { if (alive.current) setError(friendlyError(failure)); }
    finally { committing.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="content-media-field">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-sm">{label}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p></div>
      <Button type="button" size="sm" variant="secondary" disabled={disabled || busy} onClick={() => { setOpen(!open); if (!open) void load(null); }}><ImagePlus size={14} aria-hidden="true" />{open ? "收起素材" : "选择图片"}</Button></div>
    {showPreview ? value ? <div className="content-media-selection"><img src={`/api/bff/admin/content/media/${encodeURIComponent(value)}/content`} alt={`${label}预览`} className="max-h-44 w-full object-contain" /><span className="text-xs text-muted-foreground">已选择图片{allowClear ? <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => onChange(null)}>使用桌面图片</Button> : null}</span></div> : <div className="content-media-empty">{allowClear ? "未单独配置，使用桌面图片。" : "请选择一张审核通过的图片。"}</div> : null}
    {open ? <div className="space-y-4 rounded-lg border border-border p-3">
      <StatusMessage error={error} />
      {canUpload ? <div className="space-y-2"><Field label="上传新图片" hint="JPEG、PNG 或 WebP，最多 10 MiB。上传后先审核，再选择使用。"><Input type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setUploaded(null); }} /></Field><Button type="button" size="sm" variant="secondary" disabled={!file || disabled || busy} onClick={() => void upload()}><Upload size={14} aria-hidden="true" />{busy ? "处理中…" : "上传图片"}</Button></div> : null}
      {uploaded ? <div className="space-y-2"><p className="text-sm">图片已上传，待审核后才能使用。</p><img src={`/api/bff/admin/content/media/${encodeURIComponent(uploaded.assetId)}/content`} alt="刚上传的待审核图片" className="h-28 w-full object-contain" />{canReview ? <Button type="button" size="sm" disabled={disabled || busy} onClick={() => void approve()}>审核通过并加入可选素材</Button> : <p className="text-xs text-muted-foreground">请由有素材发布权限的管理员在“运营素材”审核。</p>}</div> : null}
      <div className="grid grid-cols-2 gap-2">{options.map(option => <button key={option.id} type="button" disabled={disabled || busy} className="rounded-lg border border-border p-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => { const issue = validateOption?.(option); if (issue) { setError(issue); return; } onSelected?.(option); onChange(option.id); setOpen(false); }}>
        <img src={`/api/bff/admin/content/media/${encodeURIComponent(option.id)}/content`} alt="可选图片" className="h-24 w-full object-contain" loading="lazy" /><span className="mt-2 block text-xs tabular-nums text-muted-foreground">{option.width} × {option.height}</span>
      </button>)}</div>
      {!busy && !error && !options.length ? <p className="text-sm text-muted-foreground">没有审核通过且可公开的素材。{canUpload ? "可以先上传一张图片。" : "请联系有权限的管理员上传并审核。"}</p> : null}
      {busy ? <p className="text-sm text-muted-foreground" role="status">正在读取或处理图片…</p> : null}
      {error || cursor ? <Button type="button" size="sm" variant="secondary" disabled={busy || disabled} onClick={() => void load(error ? null : cursor)}>{error ? "重试读取素材" : "加载更多"}</Button> : null}
    </div> : null}
  </div>;
}
