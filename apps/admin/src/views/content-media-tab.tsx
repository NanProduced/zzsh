import { useEffect, useRef, useState } from "react";
import { ArrowRight, ImageIcon, ImageUp, MoreHorizontal } from "lucide-react";

import { adminRequest, friendlyError, type ContentMediaPage, type ContentMediaRow } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingStatusMessage, StatusMessage } from "../components/ui-elements";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Field } from "../components/ui/field";
import { Textarea } from "../components/ui/textarea";
import { ContentImageAdjust } from "./content-image-adjust";
import { contentTime } from "./content-resources-model";
import { ContentImage, ContentMediaFileField, contentMediaFileIssue, contentMediaSize, contentMediaUrl, uploadContentMedia } from "./content-media-upload";
import "./content-media.css";

const actions = {
  approve: "审核通过并公开",
  keepPrivate: "通过但不公开",
  makePublic: "设为公开",
  makePrivate: "停止公开",
  reject: "驳回",
  quarantine: "隔离",
} as const;
type ReviewAction = keyof typeof actions;

function stateLabel(asset: ContentMediaRow) {
  return asset.reviewState === "APPROVED" ? asset.accessClass === "PUBLIC_DISPLAY" ? "可使用" : "已通过 · 未公开"
    : { PENDING: "待审核", REJECTED: "已驳回", QUARANTINED: "已隔离" }[asset.reviewState];
}

function needsReason(asset: ContentMediaRow, action: ReviewAction | null) {
  return action === "reject" || action === "quarantine" ||
    ((action === "approve" || action === "keepPrivate") && (asset.reviewState === "REJECTED" || asset.reviewState === "QUARANTINED"));
}

export function ContentMediaTab({ canEdit, canPublish, refreshNonce, onWriteLockChange, onOpenPages }: {
  canEdit: boolean;
  canPublish: boolean;
  refreshNonce: number;
  onWriteLockChange?: (locked: boolean) => void;
  onOpenPages?: () => void;
}) {
  const [page, setPage] = useState<ContentMediaPage | null>(null);
  const [selected, setSelected] = useState<ContentMediaRow | null>(null);
  const [action, setAction] = useState<ReviewAction | null>(null), [reason, setReason] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false), [file, setFile] = useState<File | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [loading, setLoading] = useState(false), [uploading, setUploading] = useState(false), [writing, setWriting] = useState(false);
  const [listError, setListError] = useState<string>(), [actionError, setActionError] = useState<string>(), [success, setSuccess] = useState<string>();
  const listSeq = useRef(0), committing = useRef(false), alive = useRef(true);
  const reviewRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const items = page?.items ?? [];

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onWriteLockChange?.(writing || uploading); }, [writing, uploading, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);

  const load = async (cursor?: string) => {
    const seq = ++listSeq.current;
    setLoading(true);
    setListError(undefined);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<ContentMediaPage>(`/content/media?${params}`);
      if (seq !== listSeq.current || !alive.current) return;
      setPage(previous => cursor && previous ? { ...result, items: [...previous.items, ...result.items.filter(item => !previous.items.some(row => row.id === item.id))] } : result);
    } catch (failure) {
      if (seq === listSeq.current && alive.current) setListError(friendlyError(failure));
    } finally {
      if (seq === listSeq.current && alive.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { listSeq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  const setReviewAction = (next: ReviewAction | null) => { setAction(next); setReason(""); setActionError(undefined); };
  const showAsset = (asset: ContentMediaRow) => {
    setSelected(asset);
    setReviewAction(asset.reviewState === "APPROVED" ? asset.accessClass === "PUBLIC_DISPLAY" ? null : "makePublic" : "approve");
  };
  const showUpload = () => { setFile(null); setAdjusting(false); setActionError(undefined); setUploadOpen(true); };

  const decide = async () => {
    if (!selected || !action || !canPublish || committing.current || (needsReason(selected, action) && [...reason.trim()].length < 2)) return;
    const isVisibility = action === "makePublic" || action === "makePrivate";
    const visibility = action === "approve" || action === "makePublic" ? "PUBLIC_DISPLAY" : "PRIVATE_REVIEW";
    const body = { visibility, ...(isVisibility ? {} : { decision: action === "reject" ? "REJECT" : action === "quarantine" ? "QUARANTINE" : "APPROVE" }), ...(reason.trim() ? { reason: reason.trim() } : {}) };
    const path = `/content/media/${encodeURIComponent(selected.id)}/${isVisibility ? "visibility" : "review"}`;
    const fingerprint = JSON.stringify([path, body]);
    if (reviewRequest.current?.fingerprint !== fingerprint) reviewRequest.current = { fingerprint, key: `idem_${crypto.randomUUID().replaceAll("-", "")}` };
    committing.current = true; setWriting(true); setActionError(undefined); setSuccess(undefined);
    try {
      const result = await adminRequest<{ id: string }>(path, body, "POST", { "idempotency-key": reviewRequest.current.key });
      if (result?.id !== selected.id) throw new Error();
      reviewRequest.current = null;
      if (!alive.current) return;
      setSuccess(visibility === "PUBLIC_DISPLAY" ? "图片已公开，可以在文章和用户站中选择。"
        : action === "reject" ? "图片已驳回。" : action === "quarantine" ? "图片已隔离。"
          : action === "keepPrivate" ? "审核通过，图片保持未公开。" : "图片已停止公开。");
      setSelected(null);
      await load();
    } catch (failure) {
      if (alive.current) setActionError(friendlyError(failure));
    } finally {
      committing.current = false;
      if (alive.current) setWriting(false);
    }
  };

  const upload = async () => {
    if (!file || contentMediaFileIssue(file) || !canEdit || committing.current) return;
    committing.current = true; setUploading(true); setActionError(undefined); setSuccess(undefined);
    try {
      const result = await uploadContentMedia(file);
      if (!alive.current) return;
      setFile(null);
      setUploadOpen(false);
      if (canPublish && result.reviewState === "PENDING") showAsset({ ...result, id: result.assetId, reviewState: "PENDING", accessClass: "PRIVATE_REVIEW", byteSize: String(result.byteSize), reviewReason: null, updatedAt: "" });
      else setSuccess("已上传到图片素材，审核通过后即可使用。");
      await load();
    } catch (failure) {
      if (alive.current) setActionError(failure instanceof Error ? failure.message : friendlyError(failure));
    } finally {
      committing.current = false;
      if (alive.current) setUploading(false);
    }
  };

  const reasonRequired = selected && needsReason(selected, action);
  const changesPublic = selected?.accessClass === "PUBLIC_DISPLAY" && (action === "makePrivate" || action === "reject" || action === "quarantine");
  const options: ReviewAction[] = selected ? [
    ...(selected.reviewState !== "APPROVED" ? ["approve", "keepPrivate"] as const
      : [selected.accessClass === "PUBLIC_DISPLAY" ? "makePrivate" : "makePublic"] as const),
    ...(selected.reviewState === "REJECTED" ? [] : ["reject"] as const),
    ...(selected.reviewState === "QUARANTINED" ? [] : ["quarantine"] as const),
  ].filter(value => value !== action) : [];
  const locked = writing || uploading;
  return <div className="content-media-workspace">
    <section className="section-panel space-y-5" aria-label="图片素材">
      <header className="content-heading">
        <div><h3 className="text-base font-semibold">图片素材</h3><p className="mt-1 text-sm text-muted-foreground">上传并审核图片，之后可用于文章插图、首页轮播、页面海报和二维码。</p></div>
        {canEdit ? <Button type="button" onClick={showUpload}><ImageUp size={16} aria-hidden="true" />上传图片</Button> : null}
      </header>
      {onOpenPages ? <div className="content-media-guide">
        <div><p className="text-sm font-medium">要换掉用户站上的图片？</p><p className="mt-1 text-sm text-muted-foreground">先找到图片所在的页面位置。换图时也可以直接上传。</p></div>
        <Button type="button" size="sm" variant="ghost" onClick={onOpenPages}>去用户站展示<ArrowRight size={14} aria-hidden="true" /></Button>
      </div> : null}
      <FloatingStatusMessage success={success} />
      {listError ? <div className="space-y-2"><StatusMessage error={listError} /><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load()}>重新读取</Button></div> : null}
      {items.length ? <div className="content-media-gallery">
        {items.map(asset => <button type="button" key={asset.id} className="content-media-card" onClick={() => showAsset(asset)}
          aria-label={`${canPublish && asset.reviewState === "PENDING" ? "审核" : "查看"}图片，${stateLabel(asset)}，${asset.width} × ${asset.height}`}>
          <div className="content-media-card-preview"><ContentImage src={contentMediaUrl(asset.id)} alt="" lazy /></div>
          <div className="content-media-card-info">
            <Badge variant={asset.reviewState === "APPROVED" && asset.accessClass === "PUBLIC_DISPLAY" ? "success" : asset.reviewState === "PENDING" ? "warning" : "secondary"}>{stateLabel(asset)}</Badge>
            <span className="text-xs tabular-nums text-muted-foreground">{asset.width} × {asset.height}</span>
          </div>
        </button>)}
      </div> : !loading && !listError ? <div className="content-media-library-empty">
        <ImageIcon size={24} aria-hidden="true" /><p className="font-medium">还没有图片</p>
        <p className="text-sm text-muted-foreground">{canEdit ? "从本地上传第一张图片，审核通过后即可使用。" : "有权限的同事上传图片后，会显示在这里。"}</p>
      </div> : null}
      {loading ? <p className="text-sm text-muted-foreground" role="status">正在读取图片…</p> : null}
      {page?.nextCursor ? <Button type="button" variant="outline" disabled={loading} onClick={() => void load(page.nextCursor ?? undefined)}>加载更多图片</Button> : null}
    </section>

    <Dialog open={uploadOpen} onOpenChange={open => { if (!open && !committing.current) setUploadOpen(false); }}>
      <DialogContent size="md" className="content-picture-picker-dialog" showCloseButton={!locked}>
        <DialogHeader><DialogTitle>上传图片</DialogTitle><DialogDescription>上传到图片素材，审核通过并公开后就能在文章或用户站中使用。</DialogDescription></DialogHeader>
        <div className="content-picture-picker-body space-y-3">
          {adjusting && file ? <ContentImageAdjust source={file} onCancel={() => setAdjusting(false)} onApply={next => { setFile(next); setAdjusting(false); setActionError(undefined); }} />
            : <ContentMediaFileField file={file} onChange={next => { setFile(next); setActionError(undefined); }} disabled={locked || !canEdit} onAdjust={() => setAdjusting(true)} />}
          <StatusMessage error={actionError} />
        </div>
        {!adjusting ? <DialogFooter><Button type="button" variant="ghost" disabled={locked} onClick={() => setUploadOpen(false)}>取消</Button>
          <Button type="button" loading={uploading} disabled={!canEdit || !file || Boolean(file && contentMediaFileIssue(file))} onClick={() => void upload()}>{canPublish ? "上传并查看" : "上传等待审核"}</Button></DialogFooter> : null}
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !committing.current) setSelected(null); }}>
      <DialogContent size="md" className="content-picture-picker-dialog" showCloseButton={!locked}>
        {selected ? <>
          <DialogHeader><DialogTitle>{selected.reviewState === "PENDING" && canPublish ? "审核图片" : "图片详情"}</DialogTitle>
            <DialogDescription>{stateLabel(selected)} · {selected.width} × {selected.height} · {contentMediaSize(selected.byteSize)}{selected.updatedAt ? ` · 更新于 ${contentTime(selected.updatedAt)}` : ""}</DialogDescription></DialogHeader>
          <div className="content-picture-picker-body space-y-4">
            <div className="content-file-preview"><ContentImage src={contentMediaUrl(selected.id)} alt="图片预览" /></div>
            {selected.reviewReason ? <p className="text-sm text-muted-foreground">上次处理说明：{selected.reviewReason}</p> : null}
            {action === "approve" || action === "makePublic" ? <p className="text-sm text-muted-foreground">公开后，同事可以在文章和用户站展示设置中选择这张图。</p> : null}
            {changesPublic ? <p className="text-sm text-muted-foreground">使用这张图的文章或页面可能不再显示该图片。</p> : null}
            {canPublish && reasonRequired ? <Field label="处理原因" hint="至少填写两个字。"><Textarea value={reason} maxLength={500} disabled={locked} onChange={event => setReason(event.target.value)} /></Field> : null}
            <StatusMessage error={actionError} />
          </div>
          <DialogFooter>
            {canPublish && options.length ? <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" disabled={locked} className="sm:mr-auto"><MoreHorizontal size={16} aria-hidden="true" />其他操作</Button>} />
              <DropdownMenuContent align="start">{options.map(option => <DropdownMenuItem key={option} onClick={() => setReviewAction(option)}>{actions[option]}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu> : null}
            <Button type="button" variant="ghost" disabled={locked} onClick={() => setSelected(null)}>关闭</Button>
            {canPublish && action ? <Button type="button" variant={changesPublic || action === "reject" || action === "quarantine" ? "danger" : "default"} loading={writing}
              disabled={uploading || Boolean(reasonRequired && [...reason.trim()].length < 2)} onClick={() => void decide()}>{actions[action]}</Button> : null}
          </DialogFooter>
        </> : null}
      </DialogContent>
    </Dialog>
  </div>;
}
