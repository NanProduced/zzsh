import { useEffect, useRef, useState } from "react";
import { DEFAULT_RESOURCES, type ContentResource, type ResourceDefinition } from "@zzsh/content";
import type { ContentMediaOption } from "../api";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Badge } from "../components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ContentImage, contentMediaUrl } from "./content-media-upload";
import { ContentMediaField } from "./content-resource-fields";
import type { ContentEditorProps } from "./content-resource-editor";
import type { ResourceVersion } from "./content-resources-model";

type PlacementResource = Extract<ContentResource, { kind: "contact" | "banner" | "carousel" }>;
export type PlacementMedia = { qrMediaId: string | null } | { mediaId: string | null; mobileMediaId: string | null } | { slides: { id: string; mediaId: string | null; mobileMediaId: string | null }[] };
export function placementMedia(value: PlacementResource): PlacementMedia {
  if (value.kind === "contact") return { qrMediaId: value.qrMediaId };
  if (value.kind === "banner") return { mediaId: value.mediaId, mobileMediaId: value.mobileMediaId };
  return { slides: value.slides.map(slide => ({ id: slide.id, mediaId: slide.mediaId, mobileMediaId: slide.mobileMediaId })) };
}
export function contentMediaChoiceIssue(definition: ResourceDefinition | null, image: Pick<ContentMediaOption, "width" | "height">): string | undefined {
  if (image.width <= 0 || image.height <= 0) return "图片尺寸无法确认，请重新选择。";
  if ((definition?.minWidth && image.width < definition.minWidth) || (definition?.minHeight && image.height < definition.minHeight)) return `这个位置的图片至少需要 ${definition?.minWidth} × ${definition?.minHeight} 像素。`;
  if (definition?.aspectRatio && Math.abs(image.width / image.height / definition.aspectRatio - 1) > (definition.aspectTolerance ?? 0)) return `这个位置需要接近 ${definition.aspectRatio}:1 的图片。`;
  return undefined;
}
export function ContentMediaEditor(props: ContentEditorProps) {
  const initial = props.detail.draft?.payload ?? props.detail.published?.payload ?? props.detail.baseline ?? props.detail.current.payload ?? props.detail.editorSource?.version.payload;
  if (!initial || initial.kind === "guide" || initial.kind === "notice" || initial.kind === "footer") return <StatusMessage error="未能读取图片位置，请返回列表重试。" />;
  return <MediaEditor {...props} initial={initial} />;
}
function MediaEditor({ detail, initial, locked, busy, pending, operationError, success, canEdit, canPublish, canUpload, canReview, onClose, onRecover, onWrite, onDirtyChange }: ContentEditorProps & { initial: PlacementResource }) {
  const [media, setMedia] = useState<PlacementMedia>(() => placementMedia(initial));
  const [restoring, setRestoring] = useState<ResourceVersion | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(media) !== JSON.stringify(placementMedia(initial));
  useEffect(() => { onDirtyChange(dirty || locked); }, [dirty, locked, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => { if (!canEdit) setRestoring(null); }, [canEdit]);

  const current = detail.current.payload;
  const active = detail.current.state === "available" && current && current.kind !== "guide" && current.kind !== "notice" && current.kind !== "footer" ? placementMedia(current) : null;
  const onlineIds = new Set(detail.current.media.filter(row => row.url).map(row => row.id));
  const rules = detail.definition;
  const label = rules?.label ?? initial.title;
  const home = DEFAULT_RESOURCES["placement:HOME_HERO"];
  const needsRebase = detail.key === "placement:HOME_HERO" && initial.kind === "carousel" && home?.kind === "carousel"
    && (initial.slides.length !== home.slides.length || initial.slides.some((slide, index) => slide.id !== home.slides[index]?.id));
  const dimensions = rules?.minWidth && rules.minHeight ? `至少 ${rules.minWidth} × ${rules.minHeight} 像素${rules.aspectRatio ? `，比例约 ${rules.aspectRatio}:1` : ""}。` : "";
  const state = detail.draft ? "有未发布草稿" : detail.current.state === "withdrawn" ? "已下线" : detail.published ? "已发布" : detail.current.source === "LEGACY" ? "沿用原轮播" : detail.current.source === "BUILTIN" ? "使用默认配置" : "尚未发布";

  const picture = (title: string, currentId: string | null, nextId: string | null, onChange: (id: string | null) => void, optional = false, fallback = "暂无线上图片") => {
    const changed = nextId !== currentId;
    const nextLabel = detail.editorSource ? "历史版本图片" : dirty ? "更换后的预览" : "草稿图片";
    const preview = (id: string, alt: string) => <div className="content-picture-preview" data-qr={initial.kind === "contact" || undefined}><ContentImage src={contentMediaUrl(id)} alt={alt} /></div>;
    return <div className="content-picture-set">
      <ContentMediaField label={title} hint={optional ? "未单独设置时使用桌面图片。" : ""} value={nextId} onChange={onChange} showPreview={false} allowClear={optional}
        disabled={locked || !canEdit || needsRebase} canUpload={canUpload} canReview={canReview} definition={rules} validateOption={option => contentMediaChoiceIssue(rules, option)} />
      <div className={changed ? "content-picture-comparison" : "content-picture-set"}>
        <div className="space-y-1.5"><p className="text-xs text-muted-foreground">当前线上</p>
          {currentId && onlineIds.has(currentId) ? preview(currentId, `当前线上${title}`) : <p className="content-picture-unset">{currentId ? "当前图片无法显示" : optional ? "使用桌面图片" : fallback}</p>}
        </div>
        {changed ? <div className="space-y-1.5"><p className="text-xs text-muted-foreground">{nextLabel}</p>
          {nextId ? preview(nextId, nextLabel) : <p className="content-picture-unset">{optional ? "使用桌面图片" : "尚未选择图片"}</p>}
        </div> : null}
      </div>
    </div>;
  };

  return <>
    <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}>
      <DialogContent size="lg" initialFocus={headingRef} className="content-picture-picker-dialog content-placement-dialog" showCloseButton={!locked} closeLabel="关闭换图窗口">
        <DialogHeader ref={headingRef} tabIndex={-1} className="outline-none">
          <DialogTitle>{canEdit ? "更换" : "查看"}{initial.kind === "contact" ? "二维码" : "页面图片"}</DialogTitle>
          <DialogDescription>{label}{rules?.locations.length ? ` · ${rules.locations.join(" · ")}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="content-picture-picker-body space-y-4">
          <div className="flex flex-wrap items-center gap-2"><Badge variant={detail.draft ? "info" : detail.published ? "success" : "secondary"}>{state}</Badge>
            <p className="text-sm text-muted-foreground">{canEdit ? "从图片素材选择或直接上传。发布后，用户站才会换图。" : "当前可查看图片。"} </p></div>
          {dimensions ? <p className="text-xs text-muted-foreground">{dimensions}{initial.kind === "contact" ? "请保留二维码周围的白边。" : ""}</p> : null}
          {operationError ? <StatusMessage error={operationError} /> : null}
          {pending && !busy ? <StatusMessage tone="warning" error="上次操作的结果还未确认，请先核对结果。" /> : null}
          {needsRebase ? <div className="space-y-3"><StatusMessage tone="warning" error="这份轮播使用旧位置。先按当前首页建立草稿，旧图片仍会保留在版本历史中。" />
            {canEdit ? <Button type="button" variant="secondary" disabled={locked} onClick={() => { if (detail.draft) setRestoring(detail.draft); else void onWrite("content.resource.draft.create", {}); }}>按当前首页建立草稿</Button> : null}
          </div> : null}
          {"qrMediaId" in media ? picture("二维码", active && "qrMediaId" in active ? active.qrMediaId : null, media.qrMediaId, qrMediaId => setMedia({ qrMediaId }))
            : "mediaId" in media ? <div className="space-y-5">
              {picture("桌面图片", active && "mediaId" in active ? active.mediaId : null, media.mediaId, mediaId => setMedia({ ...media, mediaId }), false,
                detail.key === "placement:MARKET_DELTA_BANNER" ? "使用网站默认海报" : undefined)}
              {picture("手机图片（可选）", active && "mediaId" in active ? active.mobileMediaId : null, media.mobileMediaId, mobileMediaId => setMedia({ ...media, mobileMediaId }), true)}
            </div>
            : <div className="space-y-3">{media.slides.map((slide, index) => {
              const online = active && "slides" in active ? active.slides.find(row => row.id === slide.id) : undefined;
              const change = (field: "mediaId" | "mobileMediaId", id: string | null) => setMedia({ slides: media.slides.map((row, i) => i === index ? { ...row, [field]: id } : row) });
              return <details key={slide.id} className="content-picture-slide" open={index === 0 ? true : undefined}>
                <summary>{initial.kind === "carousel" ? initial.slides[index]?.title || `轮播 ${index + 1}` : `轮播 ${index + 1}`}</summary>
                <div className="space-y-4">
                  {picture("桌面图片", online?.mediaId ?? null, slide.mediaId, id => change("mediaId", id))}
                  {picture("手机图片（可选）", online?.mobileMediaId ?? null, slide.mobileMediaId, id => change("mobileMediaId", id), true)}
                </div>
              </details>;
            })}</div>}
          {success ? <p className="text-sm text-muted-foreground" role="status">{success}</p> : null}
          {detail.versions.some(row => row.state !== "DRAFT") ? <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">版本历史</summary>
            <div className="mt-2 space-y-1">{detail.versions.filter(row => row.state !== "DRAFT").map(version => <div key={version.id} className="flex items-center justify-between gap-3">
              <span>版本 {version.sequence}{version.state === "PUBLISHED" ? " · 当前线上" : ""}</span>
              {canEdit ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setRestoring(version)}>恢复为草稿</Button> : null}
            </div>)}</div>
          </details> : null}
        </div>
        <DialogFooter>
          {pending && !busy && onRecover ? <Button type="button" onClick={onRecover}>核对操作结果</Button> : <>
            <Button type="button" variant="ghost" disabled={locked} onClick={onClose}>{dirty ? "取消更换" : "关闭"}</Button>
            {canEdit && dirty ? <Button type="button" disabled={locked || needsRebase} loading={busy} onClick={() => void onWrite("content.resource.media-draft.save", { media })}>保存图片草稿</Button> : null}
            {!dirty && canPublish && detail.draft && detail.item && !needsRebase ? <Button type="button" disabled={locked} loading={busy}
              onClick={() => void onWrite("content.resource.publish", { versionId: detail.draft!.id, expectedRevision: detail.item!.revision })}>发布图片</Button> : null}
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(restoring)} onOpenChange={open => { if (!open) setRestoring(null); }}>
      <DialogContent role="alertdialog">
        <DialogTitle>恢复为草稿？</DialogTitle>
        <DialogDescription>当前未保存的更换会被丢弃。恢复的图片在再次发布后才会出现在用户站。</DialogDescription>
        <DialogFooter>
          <Button type="button" variant="secondary" autoFocus onClick={() => setRestoring(null)}>取消</Button>
          <Button type="button" disabled={locked} onClick={() => { const version = restoring; setRestoring(null); if (version && detail.item) void onWrite("content.resource.draft.restore", { sourceVersionId: version.id, expectedRevision: detail.item.revision }); }}>恢复为草稿</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
