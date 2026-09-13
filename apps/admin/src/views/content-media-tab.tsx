import { useEffect, useRef, useState } from "react";

import {
  adminRequest,
  formatDate,
  friendlyError,
  type ContentMediaPage,
  type ContentMediaRow,
  type UploadedAssetResponse,
} from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";

const STATE_LABELS: Record<ContentMediaRow["reviewState"], string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  QUARANTINED: "已隔离",
};

export function ContentMediaTab({
  canEdit,
  canPublish,
  refreshNonce,
}: {
  canEdit: boolean;
  canPublish: boolean;
  refreshNonce: number;
}) {
  const [page, setPage] = useState<ContentMediaPage | null>(null);
  const [selected, setSelected] = useState<ContentMediaRow | null>(null);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const listSeq = useRef(0);

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
    if (decision !== "APPROVE" && reason.trim().length < 2) {
      setError("驳回或隔离必须填写具体原因。");
      return;
    }
    setLoading(true);
    setError(undefined);
    setSuccess(undefined);
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
    }
  };

  const changeVisibility = async (visibility: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW") => {
    if (!selected) return;
    setLoading(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await adminRequest(`/content/media/${selected.id}/visibility`, { visibility, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setSuccess(visibility === "PUBLIC_DISPLAY" ? "已恢复公开；公共衍生图可再次读取。" : "已撤销公开；公共读取与内容投影立即停止。");
      setSelected(null);
      await load();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
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
      const intent = await adminRequest<{ intentId: string; uploadToken: string }>("/content/media/upload-intents", { purpose: "CONTENT_MEDIA", mime: file.type, size: file.size });
      const response = await fetch(`/api/bff/admin/content/media/uploads/${intent.intentId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": file.type, "x-upload-token": intent.uploadToken, "idempotency-key": `idem_${crypto.randomUUID().replaceAll("-", "")}` },
        body: file,
      });
      const payload = await response.json().catch(() => null) as (UploadedAssetResponse & { error?: { code?: string } }) | null;
      if (!response.ok) {
        setError(payload?.error?.code === "INVALID_ARGUMENT" ? "文件内容与声明的图片类型不一致，或尺寸超出边界。" : "上传未完成，请检查文件与权限后重试。");
        return;
      }
      setFile(null);
      setSuccess("平台素材已上传并进入待审核；默认私有，审核通过后才可作为封面或轮播公开。");
      await load();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="section-panel">
        <h3 className="text-sm font-semibold">平台内容素材</h3>
        <p className="text-[11px] text-muted-foreground mt-1">
          轮播与内容封面共用平台级归属，不挂在任何游戏下；原始图始终私有，只有审核通过并公开的衍生图可被公共接口读取。撤权后新公共请求立即不可用。
        </p>
        <StatusMessage error={error} success={success} className="mt-3" />
        {canEdit ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">图片（JPEG/PNG/WebP，≤10 MiB）</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className={inputClass} />
            </label>
            <div className="flex items-end"><Button type="button" size="sm" loading={uploading} onClick={() => void upload()}>上传并进入待审</Button></div>
          </div>
        ) : <p className="text-[11px] text-muted-foreground mt-3">当前账号没有平台素材编辑权限。</p>}
      </section>

      <section className="section-panel">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">素材列表</h3>
          <span className="text-[11px] text-muted-foreground">{page?.items.length ?? 0} 条</span>
        </div>
        {page && page.items.length > 0 ? (
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead><tr><th>预览</th><th>尺寸</th><th>状态</th><th>更新时间</th><th>原因</th><th /></tr></thead>
              <tbody>
                {page.items.map((asset) => (
                  <tr key={asset.id}>
                    <td><img src={`/api/bff/admin/content/media/${asset.id}/content`} alt={`素材 ${asset.id}`} className="w-16 h-12 object-cover rounded border border-border" loading="lazy" /></td>
                    <td className="font-mono text-[11px]">{asset.width}×{asset.height} · {asset.byteSize}B</td>
                    <td>{STATE_LABELS[asset.reviewState]}{asset.accessClass === "PUBLIC_DISPLAY" ? " · 公开" : " · 私有"}</td>
                    <td className="text-[11px]">{formatDate(asset.updatedAt)}</td>
                    <td className="max-w-xs text-[11px] text-muted-foreground">{asset.reviewReason ?? ""}</td>
                    <td><Button type="button" size="sm" variant="secondary" onClick={() => setSelected(asset)}>处理</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-6 text-center">{loading ? "加载中…" : "还没有平台内容素材。"}</p>
        )}
        <div className="flex justify-end mt-4">
          <Button type="button" size="sm" variant="secondary" disabled={!page?.nextCursor || loading} onClick={() => { if (page?.nextCursor) void load(page.nextCursor); }}>下一页</Button>
        </div>
      </section>

      {selected ? (
        <section className="section-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">处理素材</h3>
              <p className="text-[11px] text-muted-foreground mt-1">{selected.id} · {selected.mime} · {selected.width}×{selected.height}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(null)}>关闭</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <img src={`/api/bff/admin/content/media/${selected.id}/content`} alt="素材预览" className="max-h-80 object-contain rounded border border-border bg-surface-raised" />
            <div className="space-y-3">
              <label className="space-y-1 text-xs block"><span className="text-muted-foreground">原因（驳回 / 隔离必填）</span><input value={reason} onChange={(event) => setReason(event.target.value)} className={inputClass} /></label>
              {canPublish ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" loading={loading} onClick={() => void decide("APPROVE", "PUBLIC_DISPLAY")}>通过并公开</Button>
                    <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void decide("APPROVE", "PRIVATE_REVIEW")}>通过但保持私有</Button>
                    <Button type="button" size="sm" variant="danger" loading={loading} onClick={() => void decide("REJECT", "PRIVATE_REVIEW")}>驳回</Button>
                    <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void decide("QUARANTINE", "PRIVATE_REVIEW")}>隔离</Button>
                  </div>
                  {selected.reviewState === "APPROVED" ? (
                    <div className="flex flex-wrap gap-2">
                      {selected.accessClass === "PRIVATE_REVIEW" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void changeVisibility("PUBLIC_DISPLAY")}>恢复公开</Button> : null}
                      {selected.accessClass === "PUBLIC_DISPLAY" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void changeVisibility("PRIVATE_REVIEW")}>撤销公开</Button> : null}
                    </div>
                  ) : null}
                </>
              ) : <StatusMessage error="当前账号可以查看但不能审核或公开素材。" />}
              <p className="text-[11px] text-muted-foreground">审核与公开在服务端校验 content.platform.publish；此面板不显示存储键或原始文件。</p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
