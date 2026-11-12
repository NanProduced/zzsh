import { useRef, useState } from "react";
import { adminRequest, AdminApiError, friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { StatusMessage } from "../components/ui-elements";
import { ContentMediaField } from "./content-resource-fields";
import { InfoTip } from "../components/ui/tooltip";

type Settings = {
  enabled: boolean;
  logoAssetId: string | null;
  position: "nw" | "ne" | "sw" | "se";
  sizePercent: number;
  opacityPercent: number;
  marginPercent: number;
};
type Policy = Settings & { revision: string };
type Preview = { maxEdge: 640 | 1920; url: string };
type Command = { body: Settings & { expectedRevision: string }; key: string };
type BusyAction = "load" | "preview" | "save";

const path = "/system/account-image-watermark";
const positionLabels = { nw: "左上", ne: "右上", sw: "左下", se: "右下" } as const;
const numericFields = [
  { key: "sizePercent", label: "Logo 缩放比例（%）", min: 5, max: 30, hint: "相对 Logo 原图尺寸缩放" },
  { key: "opacityPercent", label: "不透明度（%）", min: 1, max: 100, hint: undefined },
  { key: "marginPercent", label: "边距（短边 %）", min: 0, max: 10, hint: "按生成图片的短边计算" },
] as const;

export function AccountImageWatermarkPanel({ canReadMedia, canUploadMedia, canReviewMedia }: {
  canReadMedia: boolean; canUploadMedia: boolean; canReviewMedia: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [previewAvailable, setPreviewAvailable] = useState(false);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [images, setImages] = useState<Preview[]>([]);
  const [failedPreviews, setFailedPreviews] = useState<Preview["maxEdge"][]>([]);
  const [pending, setPending] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  async function load() {
    setBusyAction("load"); setBusy(true); setError("");
    try {
      const data = await adminRequest<{ policy: Policy; previewAvailable: boolean }>(path);
      setPolicy(data.policy); setPreviewAvailable(data.previewAvailable);
      setSampleId(null); setImages([]); setFailedPreviews([]); setNotice("");
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(false); }
  }

  async function save(command: Command) {
    setBusyAction("save"); setBusy(true); setPending(command); setError(""); setNotice("");
    try {
      const data = await adminRequest<{ policy: Policy }>(path, command.body, "PUT", { "idempotency-key": command.key });
      setPolicy(data.policy); setPending(null); setNotice("水印规则已保存。");
    } catch (failure) {
      if (failure instanceof AdminApiError && [400, 409, 422].includes(failure.status)) setPending(null);
      setError(friendlyError(failure));
    } finally { setBusy(false); }
  }

  async function preview(settings: Settings) {
    setBusyAction("preview"); setBusy(true); setError(""); setImages([]); setFailedPreviews([]);
    try {
      const data = await adminRequest<{ images: Preview[]; state?: "NO_SAMPLE" }>(path + "/preview", { ...settings, assetId: sampleId }, "POST");
      if (data.state === "NO_SAMPLE") {
        setError(canReadMedia ? "暂无可用的账号图片，请选择或上传预览底图。" : "暂无可用的账号图片，请联系有素材管理权限的管理员。");
        return;
      }
      setImages(data.images);
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(false); }
  }

  function edit(patch: Partial<Settings>) {
    setPolicy(current => current && { ...current, ...patch });
    setImages([]); setFailedPreviews([]); setNotice("");
  }

  function openEditor() {
    setOpen(true);
    if (!busy) void load();
  }

  const ready = Boolean(policy && (!policy.enabled || policy.logoAssetId?.trim())
    && numericFields.every(({ key, min, max }) => Number.isInteger(policy[key]) && policy[key] >= min && policy[key] <= max));
  const previewing = busy && busyAction === "preview";
  const saving = busy && busyAction === "save";
  const loading = busy && busyAction === "load";
  const rowValue = loading && !policy ? "正在读取设置…" : policy ? policy.enabled ? `已启用 · ${positionLabels[policy.position]}` : "已停用" : error ? "设置读取失败" : "封面与详情图的 Logo 规则";

  return <section className="mt-6 max-w-5xl border-b border-border pb-5" aria-labelledby="account-image-watermark-title">
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h2 id="account-image-watermark-title" className="text-base font-semibold">账号图片水印</h2><InfoTip label="水印生效范围说明" title="生效范围" body="改动仅影响之后生成的封面与详情图。" /></div>
        <p className="mt-0.5 text-xs text-muted-foreground">{rowValue}</p>
      </div>
      <Button ref={triggerRef} type="button" variant="outline" aria-label="设置水印" disabled={loading && !policy} onClick={openEditor}>设置</Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent size="lg" finalFocus={triggerRef} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
      <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
        <DialogTitle>账号图片水印</DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed">改动仅影响之后生成的封面与详情图；预览不会保存设置。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {!policy && busy ? <div role="status" aria-label="正在读取设置"><span className="sr-only">正在读取设置…</span><div className="space-y-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-10 w-2/3" /><Skeleton className="h-24 w-full" /></div></div> : null}
        {error ? <StatusMessage error={error} /> : null}
        {notice ? <StatusMessage success={notice} /> : null}
        {policy && loading ? <p role="status" className="text-[13px] text-muted-foreground">正在读取设置…</p> : null}
        {pending ? <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-[13px]">上次保存的结果待确认；重试会使用原操作，不会新建另一笔。</div> : null}
        {policy ? <>
          <dl className="grid grid-cols-2 gap-4 border-b border-border/60 pb-4 text-[13px]">
            <div><dt className="text-muted-foreground">当前状态</dt><dd className="mt-0.5 font-medium">{policy.enabled ? "已启用" : "已停用"}</dd></div>
            <div><dt className="text-muted-foreground">位置</dt><dd className="mt-0.5 font-medium">{positionLabels[policy.position]}</dd></div>
          </dl>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5">
              <div className="min-w-0">
                <p id="watermark-enabled-label" className="text-[13px] font-medium">启用水印</p>
                <p className="mt-0.5 text-xs text-muted-foreground">关闭后新生成的图片不带水印。</p>
              </div>
              <Switch checked={policy.enabled} disabled={busy || Boolean(pending)} aria-labelledby="watermark-enabled-label" onCheckedChange={enabled => edit({ enabled })} />
            </div>
            {policy.enabled && !policy.logoAssetId?.trim() ? <p role="status" className="text-[13px] text-amber-700 dark:text-amber-400">启用水印前需先选择水印 Logo。</p> : null}
            {canReadMedia ? <ContentMediaField label="水印 Logo" value={policy.logoAssetId} onChange={logoAssetId => edit({ logoAssetId })}
              hint="选择已审核公开的 PNG 素材，建议使用透明背景。" acceptedMime="image/png" disabled={busy || Boolean(pending)} showPreview={Boolean(policy.logoAssetId)}
              canUpload={canUploadMedia} canReview={canReviewMedia} /> : <p className="text-[13px] text-muted-foreground">无运营素材读取权限，无法更换 Logo。</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex w-full min-w-0 flex-col gap-1.5">
                <label id="watermark-position-label" className="text-[13px] leading-relaxed font-medium">位置</label>
                <Select value={policy.position} disabled={busy || Boolean(pending)} onValueChange={next => next && edit({ position: next as Settings["position"] })}>
                  <SelectTrigger aria-labelledby="watermark-position-label" className="h-9 w-full text-base md:text-sm"><SelectValue>{positionLabels[policy.position]}</SelectValue></SelectTrigger>
                  <SelectContent>{Object.entries(positionLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {numericFields.map(({ key, label, min, max, hint }) => {
                const invalid = !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max;
                return <Field key={key} label={label} hint={hint} error={invalid ? `请输入 ${min}–${max} 的整数。` : undefined}>
                  <Input className="h-9 text-base md:text-sm" type="number" value={policy[key]} min={min} max={max} disabled={busy || Boolean(pending)}
                    onChange={event => edit({ [key]: Number(event.target.value) })} />
                </Field>;
              })}
            </div>
          </div>
          {previewAvailable ? <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-[13px] font-medium">预览水印效果</h3><InfoTip label="预览说明" title="预览范围" body="使用一张已公开的账号图片；可更换底图，预览不会保存设置。" /></div>
            {canReadMedia ? <ContentMediaField label="更换预览底图" value={sampleId} onChange={value => { setSampleId(value); setImages([]); setFailedPreviews([]); }}
              hint="仅限公开素材，请勿上传隐私图片。" showPreview={Boolean(sampleId)} allowClear clearLabel="使用默认账号图片"
              disabled={busy || Boolean(pending)} canUpload={canUploadMedia} canReview={canReviewMedia} /> : null}
            <Button type="button" variant="secondary" size="sm" disabled={busy || !ready} onClick={() => { const { revision, ...settings } = policy; void preview({ ...settings, logoAssetId: settings.logoAssetId?.trim() || null }); }}>{previewing ? "预览中…" : "预览封面和详情"}</Button>
            {images.length ? <div className="grid gap-3 sm:grid-cols-2">{images.map(image => <figure key={image.maxEdge} className="overflow-hidden rounded-lg border border-border/70">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                <figcaption className="text-[13px] font-medium">{image.maxEdge === 640 ? "列表封面" : "详情图"}</figcaption>
                <span className="text-xs text-muted-foreground">最长边 {image.maxEdge}px</span>
              </div>
              <div className="grid min-h-40 place-items-center bg-muted/20 p-3">
                {failedPreviews.includes(image.maxEdge) ? <p role="status" className="text-[13px] text-muted-foreground">预览无法读取，请更换底图或重试。</p>
                  : <img src={image.url} alt={image.maxEdge === 640 ? "列表封面预览" : "详情图预览"} className="max-h-56 w-full object-contain" referrerPolicy="no-referrer" onError={() => setFailedPreviews(current => [...current, image.maxEdge])} />}
              </div>
            </figure>)}</div> : null}
          </div> : <p className="text-[13px] text-muted-foreground">OSS 图片处理尚未启用，当前无法生成预览。</p>}
        </> : null}
      </div>
      <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/60 bg-muted/30 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
        {!policy ? <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>重新读取</Button> : null}
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{notice ? "关闭" : "取消"}</Button>
        {pending ? <Button type="button" disabled={busy} onClick={() => void save(pending)}>重试保存</Button>
          : policy ? <Button type="button" disabled={busy || !ready} onClick={() => {
            const { revision, ...settings } = policy;
            void save({ body: { ...settings, logoAssetId: settings.logoAssetId?.trim() || null, expectedRevision: revision }, key: `account-image-watermark-${crypto.randomUUID()}` });
          }}>{saving ? "保存中…" : "保存水印设置"}</Button> : null}
      </div>
    </DialogContent></Dialog>
  </section>;
}
