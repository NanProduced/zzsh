import { useEffect, useRef, useState } from "react";
import { ImageUp } from "lucide-react";

import {
  adminRequest,
  formatDate,
  friendlyError,
  type ContentMediaPage,
  type ContentMediaRow,
  type UploadedAssetResponse,
} from "../api";
import { Badge } from "../components/ui/badge";
import { Button, StatusMessage } from "../components/ui-elements";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";

const STATE_LABELS: Record<ContentMediaRow["reviewState"], string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  QUARANTINED: "已隔离",
};

export async function uploadContentMedia(file: File): Promise<UploadedAssetResponse> {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type) || file.size > 10 * 1024 * 1024 || file.size === 0) throw new Error("请选择 JPEG、PNG 或 WebP 图片，文件大小不能超过 10 MiB。");
  const intent = await adminRequest<{ intentId: string; uploadToken: string }>("/content/media/upload-intents", { purpose: "CONTENT_MEDIA", mime: file.type, size: file.size });
  const response = await fetch(`/api/bff/admin/content/media/uploads/${intent.intentId}`, {
    method: "PUT", credentials: "include", headers: { "content-type": file.type, "x-upload-token": intent.uploadToken, "idempotency-key": `idem_${crypto.randomUUID().replaceAll("-", "")}` }, body: file,
  });
  const payload = await response.json().catch(() => null) as (UploadedAssetResponse & { error?: { code?: string } }) | null;
  if (!response.ok || !payload?.assetId) throw new Error(payload?.error?.code === "INVALID_ARGUMENT" ? "文件内容与声明的图片类型不一致，或尺寸超出边界。" : "上传结果未确认，请先检查素材列表，避免重复上传。");
  return payload;
}

export function ContentMediaTab({
  canEdit,
  canPublish,
  refreshNonce,
  onWriteLockChange,
}: {
  canEdit: boolean;
  canPublish: boolean;
  refreshNonce: number;
  onWriteLockChange?: (locked: boolean) => void;
}) {
  const [page, setPage] = useState<ContentMediaPage | null>(null);
  const [selected, setSelected] = useState<ContentMediaRow | null>(null);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [writing, setWriting] = useState(false);
  useEffect(() => { onWriteLockChange?.(writing || uploading); }, [writing, uploading, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const listSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const items = page?.items ?? [];
  const stateCounts = (["PENDING", "APPROVED", "REJECTED", "QUARANTINED"] as const).map(state => ({ state, count: items.filter(item => item.reviewState === state).length }));

  const load = async (cursor?: string) => {
    const seq = ++listSeq.current;
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<ContentMediaPage>(`/content/media?${params.toString()}`);
      if (seq !== listSeq.current) return;
      setPage(result);
    } catch (failure) {
      if (seq !== listSeq.current) return;
      setError(friendlyError(failure));
    } finally {
      if (seq === listSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      listSeq.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  const decide = async (decision: "APPROVE" | "REJECT" | "QUARANTINE", visibility: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW") => {
    if (!selected) return;
    const needsReason = decision !== "APPROVE" || selected.reviewState === "REJECTED" || selected.reviewState === "QUARANTINED";
    if (needsReason && reason.trim().length < 2) {
      setError("本次决定需要 2 字以上的具体原因。");
      return;
    }
    setLoading(true);
    setError(undefined);
    setSuccess(undefined);
    setWriting(true);
    try {
      await adminRequest(`/content/media/${selected.id}/review`, { decision, ...(reason.trim() ? { reason: reason.trim() } : {}), visibility });
      setSuccess(`素材已${decision === "APPROVE" ? "通过" : decision === "REJECT" ? "驳回" : "隔离"}。`);
      setReason("");
      setSelected(null);
      await load();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
      setWriting(false);
    }
  };

  const changeVisibility = async (visibility: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW") => {
    if (!selected) return;
    setLoading(true);
    setError(undefined);
    setSuccess(undefined);
    setWriting(true);
    try {
      await adminRequest(`/content/media/${selected.id}/visibility`, { visibility, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setSuccess(visibility === "PUBLIC_DISPLAY" ? "已恢复公开。" : "已撤销公开。");
      setSelected(null);
      await load();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
      setWriting(false);
    }
  };

  const upload = async () => {
    if (!file) {
      setError("请选择图片文件（JPEG/PNG/WebP，≤10 MiB）。");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("单文件不能超过 10 MiB。");
      return;
    }
    setUploading(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await uploadContentMedia(file);
      setFile(null);
      setSuccess("已上传，待审核。");
      await load();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setUploading(false);
    }
  };

  const showReason = (page?.items ?? []).some(asset => asset.reviewReason);

  return (
    <div className="content-media-workspace">
      <section className="section-panel">
        <div className="content-heading">
          <div><h3 className="text-base font-semibold">运营素材</h3><p className="mt-1 text-sm text-muted-foreground">审核通过并公开后，才能用于封面、轮播或正文。</p></div>
          <div className="content-fact-chips">{stateCounts.filter(row => row.count > 0).map(row => <Badge key={row.state} variant={row.state === "APPROVED" ? "success" : row.state === "PENDING" ? "warning" : "secondary"}>{STATE_LABELS[row.state]} {row.count}</Badge>)}</div>
        </div>
        <StatusMessage error={error} success={success} className="mt-3" />
        {canEdit ? <div className="content-media-upload">
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <div className="content-media-pick">
            <Button type="button" size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}><ImageUp size={14} aria-hidden="true" />选择图片</Button>
            <span className="content-media-file" data-empty={!file} title={file?.name}>{file ? file.name : "JPEG/PNG/WebP · ≤10 MiB"}</span>
          </div>
          <Button type="button" size="sm" loading={uploading} disabled={!file} onClick={() => void upload()}>上传并进入待审</Button>
        </div> : <p className="mt-3 text-xs text-muted-foreground">当前账号没有素材编辑权限。</p>}
        <div className="content-list-meta"><span>本页 {items.length} 条 · 更新时间倒序</span></div>
        {page && items.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table content-media-table">
              <thead><tr><th>预览</th><th>尺寸</th><th>状态</th><th>更新时间</th>{showReason ? <th>原因</th> : null}<th /></tr></thead>
              <tbody>
                {items.map((asset) => (
                  <tr key={asset.id}>
                    <td><img src={`/api/bff/admin/content/media/${asset.id}/content`} alt={`素材 ${asset.id}`} className="content-media-thumb" loading="lazy" /></td>
                    <td className="font-mono text-[11px]">{asset.width}×{asset.height} · {asset.byteSize}B</td>
                    <td><Badge variant={asset.reviewState === "APPROVED" ? "success" : asset.reviewState === "PENDING" ? "warning" : "secondary"}>{STATE_LABELS[asset.reviewState]}</Badge><span className="content-item-sub">{asset.accessClass === "PUBLIC_DISPLAY" ? " · 公开可读" : " · 私有"}</span></td>
                    <td className="text-[11px]">{formatDate(asset.updatedAt)}</td>
                    {showReason ? <td className="max-w-xs text-[11px] text-muted-foreground">{asset.reviewReason ?? ""}</td> : null}
                    <td><Button type="button" size="sm" variant="secondary" onClick={() => setSelected(asset)}>处理</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-xs text-muted-foreground py-8 text-center" role="status">{loading ? "加载中…" : "还没有素材；上传后在这里审核。"}</p>}
        <div className="content-pager"><span /><Button type="button" size="sm" variant="secondary" disabled={!page?.nextCursor || loading} onClick={() => { if (page?.nextCursor) void load(page.nextCursor); }}>下一页</Button></div>
      </section>

      <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null); }}>
        <DialogContent size="lg" className="content-media-review-dialog">
          <DialogTitle>处理素材</DialogTitle>
          <DialogDescription>{selected ? `${selected.id} · ${selected.mime} · ${selected.width}×${selected.height}` : ""}</DialogDescription>
          {selected ? <div className="content-media-review-body">
            <img src={`/api/bff/admin/content/media/${selected.id}/content`} alt="素材预览" className="content-media-review-preview" />
            <div className="content-media-review-panel">
              <div className="content-review-heading">
                <h3>{STATE_LABELS[selected.reviewState]}</h3>
                <div className="content-item-facts"><span>{selected.accessClass === "PUBLIC_DISPLAY" ? "公开可读" : "私有"}</span><span>·</span><span>{selected.width}×{selected.height}</span><span>·</span><span>{selected.byteSize}B</span></div>
              </div>
              <label className="content-settings-field"><span>处置说明（驳回/隔离或重新审核必填）</span><Input value={reason} onChange={(event) => setReason(event.target.value)} className="h-9 text-sm" disabled={loading || !canPublish} /></label>
              {!canPublish ? <StatusMessage tone="warning" error="当前账号可以查看但不能审核或公开素材。" /> : null}
              {canPublish ? <div className="content-review-actions">
                {selected.reviewState !== "APPROVED" ? <>
                  <p className="content-review-group-label">审核</p>
                  <Button type="button" size="sm" className="h-9 w-full" loading={loading} onClick={() => void decide("APPROVE", "PUBLIC_DISPLAY")}>通过并公开</Button>
                  <Button type="button" size="sm" variant="secondary" className="h-9 w-full" loading={loading} onClick={() => void decide("APPROVE", "PRIVATE_REVIEW")}>通过但保持私有</Button>
                </> : null}
                {selected.reviewState === "APPROVED" ? <>
                  <p className="content-review-group-label">公开范围</p>
                  {selected.accessClass === "PUBLIC_DISPLAY" ? <Button type="button" size="sm" variant="secondary" className="h-9 w-full" loading={loading} onClick={() => void changeVisibility("PRIVATE_REVIEW")}>撤销公开</Button> : <Button type="button" size="sm" className="h-9 w-full" loading={loading} onClick={() => void changeVisibility("PUBLIC_DISPLAY")}>恢复公开</Button>}
                </> : null}
                <p className="content-review-group-label">风险处置</p>
                <div className="content-review-danger-grid">
                  {selected.reviewState !== "REJECTED" ? <Button type="button" size="sm" variant="danger" className="h-9 w-full" loading={loading} onClick={() => void decide("REJECT", "PRIVATE_REVIEW")}>驳回</Button> : null}
                  {selected.reviewState !== "QUARANTINED" ? <Button type="button" size="sm" variant="secondary" className="h-9 w-full" loading={loading} onClick={() => void decide("QUARANTINE", "PRIVATE_REVIEW")}>隔离</Button> : null}
                </div>
              </div> : null}
            </div>
          </div> : null}
          <DialogFooter className="content-media-review-actions">
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
