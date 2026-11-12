import { useState } from "react";
import { adminRequest, AdminApiError, friendlyError } from "../api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StatusMessage } from "../components/ui-elements";
import { ContentMediaField } from "./content-resource-fields";

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

const path = "/system/account-image-watermark";
const numericFields = [
  { key: "sizePercent", label: "Logo 缩放比例（%）", min: 5, max: 30 },
  { key: "opacityPercent", label: "不透明度（%）", min: 1, max: 100 },
  { key: "marginPercent", label: "边距（短边 %）", min: 0, max: 10 },
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setBusy(true); setError("");
    try {
      const data = await adminRequest<{ policy: Policy; previewAvailable: boolean }>(path);
      setPolicy(data.policy); setPreviewAvailable(data.previewAvailable);
      setSampleId(null); setImages([]); setFailedPreviews([]); setNotice("");
    } catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(false); }
  }

  async function save(command: Command) {
    setBusy(true); setPending(command); setError(""); setNotice("");
    try {
      const data = await adminRequest<{ policy: Policy }>(path, command.body, "PUT", { "idempotency-key": command.key });
      setPolicy(data.policy); setPending(null); setNotice("水印规则已保存。");
    } catch (failure) {
      if (failure instanceof AdminApiError && [400, 409, 422].includes(failure.status)) setPending(null);
      setError(friendlyError(failure));
    } finally { setBusy(false); }
  }

  async function preview(settings: Settings) {
    setBusy(true); setError(""); setImages([]); setFailedPreviews([]);
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

  const ready = Boolean(policy && (!policy.enabled || policy.logoAssetId?.trim())
    && numericFields.every(({ key, min, max }) => Number.isInteger(policy[key]) && policy[key] >= min && policy[key] <= max));

  return <section className="mt-6 max-w-5xl border-b border-border pb-5" aria-labelledby="account-image-watermark-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 id="account-image-watermark-title" className="text-base font-semibold">账号图片水印</h2><p className="mt-1 text-sm text-muted-foreground">修改后，随后生成的封面和详情图采用新规则。</p></div>
      <Button type="button" variant="outline" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && !policy && !busy) void load(); }}>{open ? "收起水印设置" : "设置水印"}</Button>
    </div>
    {open ? <div className="mt-4 grid max-w-2xl gap-4">
      {error ? <StatusMessage error={error} /> : null}
      {notice ? <StatusMessage success={notice} /> : null}
      {busy ? <p className="text-sm text-muted-foreground" role="status">正在处理…</p> : null}
      {policy ? <>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || Boolean(pending)} checked={policy.enabled} onChange={event => edit({ enabled: event.target.checked })} />启用水印</label>
        {canReadMedia ? <ContentMediaField label="水印 Logo" value={policy.logoAssetId} onChange={logoAssetId => edit({ logoAssetId })}
          hint="选择已审核公开的 PNG 素材，建议使用透明背景。" acceptedMime="image/png" disabled={busy || Boolean(pending)}
          canUpload={canUploadMedia} canReview={canReviewMedia} /> : <p className="text-sm text-muted-foreground">当前账号没有运营素材读取权限，无法选择或更换 Logo。</p>}
        <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy || Boolean(pending)}>
          <label className="grid gap-1 text-sm">位置<select className="h-9 rounded-md border border-border bg-background px-3" value={policy.position} onChange={event => edit({ position: event.target.value as Settings["position"] })}><option value="nw">左上</option><option value="ne">右上</option><option value="sw">左下</option><option value="se">右下</option></select></label>
          {numericFields.map(({ key, label, min, max }) => <label key={key} className="grid gap-1 text-sm">{label}<Input type="number" value={policy[key]} min={min} max={max} onChange={event => edit({ [key]: Number(event.target.value) })} />{key === "sizePercent" ? <span className="text-xs text-muted-foreground">相对 Logo 原图尺寸缩放</span> : key === "marginPercent" ? <span className="text-xs text-muted-foreground">按生成图片的短边计算</span> : null}</label>)}
        </fieldset>
        {previewAvailable ? <div className="space-y-3 border-t border-border pt-4">
          <div><h3 className="text-sm font-medium">预览水印效果</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">默认使用一张已获公开权限的账号图片。没有可用图片时，可从运营素材中选择或上传预览底图；预览不会保存设置。</p></div>
          {canReadMedia ? <ContentMediaField label="更换预览底图" value={sampleId} onChange={value => { setSampleId(value); setImages([]); setFailedPreviews([]); }}
            hint="仅使用公开运营素材；上传并审核后图片可公开读取，请勿上传隐私图片。" showPreview={Boolean(sampleId)} allowClear clearLabel="使用默认账号图片"
            disabled={busy || Boolean(pending)} canUpload={canUploadMedia} canReview={canReviewMedia} /> : null}
          <Button type="button" variant="secondary" disabled={busy || !ready} onClick={() => { const { revision, ...settings } = policy; void preview({ ...settings, logoAssetId: settings.logoAssetId?.trim() || null }); }}>预览封面和详情</Button>
        </div> : <p className="text-sm text-muted-foreground">OSS 图片处理尚未启用，当前无法生成预览。</p>}
        {images.length ? <div className="grid gap-3 sm:grid-cols-2">{images.map(image => <figure key={image.maxEdge} className="rounded-md border border-border p-3"><figcaption className="mb-2 text-sm">{image.maxEdge === 640 ? "列表封面" : "详情图"} · 最长边 {image.maxEdge}px</figcaption>{failedPreviews.includes(image.maxEdge) ? <p role="status" className="text-sm text-muted-foreground">预览无法读取，请更换底图或重试。</p> : <img src={image.url} alt={image.maxEdge === 640 ? "列表封面预览" : "详情图预览"} className="max-h-48 w-full object-contain" referrerPolicy="no-referrer" onError={() => setFailedPreviews(current => [...current, image.maxEdge])} />}</figure>)}</div> : null}
      </> : null}
      <div className="flex gap-3">
        <Button type="button" variant="outline" disabled={busy || Boolean(pending)} onClick={() => void load()}>重新读取</Button>
        {pending ? <Button type="button" disabled={busy} onClick={() => void save(pending)}>重试保存</Button> : policy ? <Button type="button" disabled={busy || !ready} onClick={() => {
          const { revision, ...settings } = policy;
          void save({ body: { ...settings, logoAssetId: settings.logoAssetId?.trim() || null, expectedRevision: revision }, key: `account-image-watermark-${crypto.randomUUID()}` });
        }}>保存水印设置</Button> : null}
      </div>
    </div> : null}
  </section>;
}
