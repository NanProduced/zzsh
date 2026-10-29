import { useEffect, useRef, useState } from "react";
import { DEFAULT_RESOURCES, type ContentResource, type ResourceDefinition } from "@zzsh/content";
import type { ContentMediaOption } from "../api";
import { Button, StatusMessage } from "../components/ui-elements";
import { Badge } from "../components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ContentMediaField } from "./content-resource-fields";
import type { ContentEditorProps } from "./content-resource-editor";
import type { ResourceVersion } from "./content-resources-model";

type PlacementResource = Extract<ContentResource, {kind: "contact" | "banner" | "carousel"}>;
export type PlacementMedia = { qrMediaId: string | null } | { mediaId: string | null; mobileMediaId: string | null } | { slides: {id: string; mediaId: string | null; mobileMediaId: string | null}[] };
export function placementMedia(value: PlacementResource): PlacementMedia {
  if (value.kind === "contact") return { qrMediaId: value.qrMediaId };
  if (value.kind === "banner") return { mediaId: value.mediaId, mobileMediaId: value.mobileMediaId };
  return { slides: value.slides.map(slide => ({ id: slide.id, mediaId: slide.mediaId, mobileMediaId: slide.mobileMediaId })) };
}
export function contentMediaChoiceIssue(definition: ResourceDefinition | null, image: Pick<ContentMediaOption,"width"|"height">): string | undefined {
  if (image.width <= 0 || image.height <= 0) return "图片尺寸无法确认，请重新选择。";
  if (definition?.minWidth && image.width < definition.minWidth || definition?.minHeight && image.height < definition.minHeight) return `这个位置的图片至少需要 ${definition?.minWidth} × ${definition?.minHeight}，请重新选择。`;
  if (definition?.aspectRatio && Math.abs(image.width / image.height / definition.aspectRatio - 1) > (definition.aspectTolerance ?? 0)) return `这个位置需要约 ${definition.aspectRatio}:1 的图片，请重新选择。`;
  return undefined;
}
export function ContentMediaEditor(props: ContentEditorProps) {
  const initial = props.detail.draft?.payload ?? props.detail.published?.payload ?? props.detail.baseline ?? props.detail.current.payload ?? props.detail.editorSource?.version.payload;
  if (!initial || initial.kind === "guide" || initial.kind === "notice") return <StatusMessage error="未能读取图片位置，请返回列表重试。" />;
  return <MediaEditor {...props} initial={initial} />;
}
function MediaEditor({ detail, initial, locked, busy, pending, operationError, success, canEdit, canPublish, canUpload, canReview, onClose, onRecover, onWrite, onDirtyChange }: ContentEditorProps & { initial: PlacementResource }) {
  const baseline = placementMedia(initial), [media, setMedia] = useState<PlacementMedia>(baseline), [restoring, setRestoring] = useState<ResourceVersion | null>(null);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const headingRef = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(media) !== JSON.stringify(baseline), label = detail.definition?.label ?? initial.title;
  const rememberSize = (id: string, image: HTMLImageElement) => { if (image.naturalWidth) setSizes(current => current[id]?.width === image.naturalWidth ? current : { ...current, [id]: { width: image.naturalWidth, height: image.naturalHeight } }); };
  useEffect(() => { onDirtyChange(dirty || locked); }, [dirty, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => { if (!canEdit) setRestoring(null); }, [canEdit]);
  const current = detail.current.payload, currentMedia = current && current.kind !== "guide" && current.kind !== "notice" ? placementMedia(current) : null;
  const boundId = currentMedia && "qrMediaId" in currentMedia ? currentMedia.qrMediaId : currentMedia && "mediaId" in currentMedia ? currentMedia.mediaId : null;
  const oldId = boundId && detail.current.media.some(row => row.id === boundId && row.url) ? boundId : null;
  const nextId = "qrMediaId" in media ? media.qrMediaId : "mediaId" in media ? media.mediaId : null;
  const candidateId = initial.kind === "contact" && nextId === boundId ? null : nextId;
  const candidateLabel = initial.kind === "contact" && !candidateId ? "选图后在这里预览" : dirty ? "候选图片（未保存）" : detail.draft ? "草稿图片（未发布）" : detail.editorSource ? "历史版本图片" : "选图后在这里预览";
  const rules = detail.definition;
  const home = DEFAULT_RESOURCES["placement:HOME_HERO"];
  const needsRebase = detail.key === "placement:HOME_HERO" && initial.kind === "carousel" && home?.kind === "carousel" && JSON.stringify(initial.slides.map(slide => slide.id)) !== JSON.stringify(home.slides.map(slide => slide.id));
  const hint = rules?.minWidth && rules.minHeight ? `至少 ${rules.minWidth} × ${rules.minHeight}，比例约 ${rules.aspectRatio}:1。${rules.recommendedSize ? `建议 ${rules.recommendedSize}。` : ""}` : "保持原图比例，使用已审核并允许公开的素材。";
  const fieldProps = { disabled: locked || !canEdit || needsRebase, canUpload, canReview, onSelected: (option: ContentMediaOption) => setSizes(current => ({ ...current, [option.id]: { width: option.width, height: option.height } })), validateOption: (option: ContentMediaOption) => contentMediaChoiceIssue(rules, option) };
  return <>
    <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}><DialogContent size="lg" initialFocus={headingRef} className="content-media-dialog" showCloseButton={!locked} closeLabel="关闭图片面板">
      <div ref={headingRef} tabIndex={-1} className="outline-none"><DialogTitle>{canEdit ? initial.kind === "contact" ? "更换二维码" : "更换页面图片" : "查看页面图片"}</DialogTitle><DialogDescription>{label} · {detail.definition?.locations.join(" · ")}</DialogDescription></div><div className="content-item-facts"><Badge variant={detail.published ? "success" : detail.current.state === "withdrawn" ? "warning" : "info"}>{detail.published ? `线上 v${detail.published.sequence}` : detail.current.state === "withdrawn" ? "线上已撤回" : detail.current.source === "BUILTIN" ? "内置内容" : "尚未发布"}</Badge>{detail.draft ? <Badge variant="info">草稿 v{detail.draft.sequence}</Badge> : null}{needsRebase ? <Badge variant="warning">旧轮播位置待重建</Badge> : null}</div>
      <div className="content-media-dialog-body">
        {operationError ? <StatusMessage error={operationError} /> : null}
        {pending && !busy ? <StatusMessage tone="warning" error="请求结果尚未确认。请核对原操作，当前不能重新提交或取消已发送的操作。" /> : null}
        {needsRebase ? <div className="space-y-3"><StatusMessage tone="warning" error="此版本使用旧轮播位置。需要按当前页面重新建立固定位置，旧图片绑定会保留在历史记录中。" />{canEdit ? <Button type="button" variant="secondary" disabled={locked} onClick={() => { if (detail.draft) setRestoring(detail.draft); else void onWrite("content.resource.draft.create", {}); }}>按当前页面位置重新建立草稿</Button> : null}</div> : null}
        <p className="text-sm text-muted-foreground">仅更换图片；页面文字与跳转不变。</p>
        {initial.kind !== "carousel" ? <div className="content-media-comparison"><div><p className="mb-2 text-xs text-muted-foreground">当前线上图片</p>{oldId ? <><img className={initial.kind === "contact" ? "content-media-qr" : undefined} src={`/api/bff/admin/content/media/${encodeURIComponent(oldId)}/content`} alt="当前线上图片" onLoad={event => rememberSize(oldId, event.currentTarget)} /><span className="content-media-size">{sizes[oldId] ? `${sizes[oldId].width} × ${sizes[oldId].height}` : "读取实际尺寸…"}</span></> : boundId ? <div className="content-media-empty content-media-warning">当前图片已撤权或无法读取。</div> : <div className="content-media-empty">尚未配置图片。</div>}</div><div><p className="mb-2 text-xs text-muted-foreground">{candidateLabel}</p>{candidateId ? <><img className={initial.kind === "contact" ? "content-media-qr" : undefined} src={`/api/bff/admin/content/media/${encodeURIComponent(candidateId)}/content`} alt="候选图片" onLoad={event => rememberSize(candidateId, event.currentTarget)} /><span className="content-media-size">{sizes[candidateId] ? `${sizes[candidateId].width} × ${sizes[candidateId].height}` : "读取实际尺寸…"}</span></> : <div className="content-media-empty">尚未选择图片。</div>}</div></div> : null}
        {"qrMediaId" in media ? <ContentMediaField label="二维码图片" showPreview={false} value={media.qrMediaId} onChange={qrMediaId => setMedia({ qrMediaId })} hint={`${hint}保留完整白边。`} {...fieldProps} /> : "mediaId" in media ? <><ContentMediaField label="桌面图片" value={media.mediaId} onChange={mediaId => setMedia({ ...media, mediaId })} hint={hint} {...fieldProps} /><ContentMediaField label="手机图片（可选）" value={media.mobileMediaId} onChange={mobileMediaId => setMedia({ ...media, mobileMediaId })} hint="未配置时使用桌面图。" allowClear {...fieldProps} /></> : <div className="space-y-6">{media.slides.map((slide, index) => <div key={slide.id} className="space-y-3"><h4 className="text-sm font-medium">{initial.kind === "carousel" ? initial.slides[index]?.title || `位置 ${index + 1}` : `位置 ${index + 1}`}</h4><ContentMediaField label="桌面图片" value={slide.mediaId} onChange={mediaId => setMedia({ slides: media.slides.map((row, i) => i === index ? { ...row, mediaId } : row) })} hint={hint} {...fieldProps} /><ContentMediaField label="手机图片（可选）" value={slide.mobileMediaId} onChange={mobileMediaId => setMedia({ slides: media.slides.map((row, i) => i === index ? { ...row, mobileMediaId } : row) })} hint="未配置时使用桌面图。" allowClear {...fieldProps} /></div>)}</div>}
        <div className="content-media-status"><p>{detail.current.state === "withdrawn" ? "线上图片已撤回。" : detail.draft ? `草稿 v${detail.draft.sequence} 未发布。` : "保存生成草稿，发布后才替换线上图。"}</p><p>尺寸通过不等于实际扫码或 OSS 链路通过。</p>{success ? <p className="content-save-success" role="status">{success}</p> : null}</div>
        {detail.versions.length ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">历史版本</summary><div className="mt-3 space-y-2">{detail.versions.filter(row => row.state !== "DRAFT").map(version => <div key={version.id} className="flex items-center justify-between gap-3"><span>v{version.sequence} · {version.state === "PUBLISHED" ? "线上" : "历史"}</span>{canEdit ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setRestoring(version)}>恢复为草稿</Button> : null}</div>)}</div></details> : null}
      </div>
      <DialogFooter className="content-media-dialog-footer">
        {pending && !busy && onRecover ? <Button type="button" variant="secondary" loading={busy} onClick={onRecover}>核对原操作结果</Button> : <Button type="button" variant="ghost" disabled={locked} onClick={onClose}>{dirty ? "取消更换" : "关闭"}</Button>}
        {canEdit ? <Button type="button" variant="secondary" disabled={locked || !dirty || needsRebase} onClick={() => { if (!locked && dirty && !needsRebase) void onWrite("content.resource.media-draft.save", { media }); }}>保存图片草稿</Button> : null}
        {canPublish ? <Button type="button" disabled={locked || dirty || !detail.draft || needsRebase} onClick={() => { if (!locked && !dirty && detail.draft && !needsRebase) void onWrite("content.resource.publish", { versionId: detail.draft.id, expectedRevision: detail.item!.revision }); }}>{busy ? "处理中…" : "发布图片"}</Button> : null}
      </DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={Boolean(restoring)} onOpenChange={open => { if (!open) setRestoring(null); }}><DialogContent role="alertdialog"><DialogTitle>恢复 v{restoring?.sequence} 的图片绑定？</DialogTitle><DialogDescription>会替换当前工作副本。已有草稿保留为历史，恢复后仍需重新校验媒体资格并发布。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setRestoring(null)}>取消</Button><Button type="button" disabled={locked} onClick={() => { const version = restoring; setRestoring(null); if (version) void onWrite("content.resource.draft.restore", { sourceVersionId: version.id, expectedRevision: detail.item!.revision }); }}>恢复为草稿</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
