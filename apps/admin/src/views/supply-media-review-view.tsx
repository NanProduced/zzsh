import { useCallback, useEffect, useMemo, useState } from "react";

import { adminRequest, friendlyError, hasPermission, type MediaAssetReview, type MediaReviewPage, type SessionSnapshot, type SupplyGame, type UploadedAssetResponse } from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const selectClass = "w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs";

const STATE_LABELS: Record<MediaAssetReview["reviewState"], string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  QUARANTINED: "已隔离",
};

const PURPOSE_LABELS: Record<MediaAssetReview["purpose"], string> = {
  GAME_COVER: "游戏封面",
  SKIN_MEDIA: "皮肤图",
  ITEM_MEDIA: "物品图",
  ACCOUNT_EVIDENCE: "账号凭证",
};

export function SupplyMediaReviewView({
  snapshot,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  refreshNonce?: number;
}) {
  const canRead = hasPermission(snapshot, "supply.review.read");
  const canDecide = hasPermission(snapshot, "supply.review.decide");
  const canUpload = hasPermission(snapshot, "supply.catalog.manage");
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [state, setState] = useState<MediaAssetReview["reviewState"]>("PENDING");
  const [ownershipKind, setOwnershipKind] = useState<"PLATFORM_CATALOG" | "USER_SUPPLY">("PLATFORM_CATALOG");
  const [page, setPage] = useState<MediaReviewPage | null>(null);
  const [selected, setSelected] = useState<MediaAssetReview | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [uploadGameId, setUploadGameId] = useState("");
  const [uploadPurpose, setUploadPurpose] = useState<"GAME_COVER" | "SKIN_MEDIA" | "ITEM_MEDIA">("GAME_COVER");
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const gameNames = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);

  const loadGames = useCallback(async () => {
    if (!canUpload) return;
    const result = await adminRequest<{ games: SupplyGame[] }>("/supply/games");
    setGames(result.games);
    setUploadGameId((current) => (current && result.games.some((game) => game.id === current) ? current : result.games[0]?.id ?? ""));
  }, [canUpload]);

  const loadReviews = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams({ state, ownershipKind, limit: "20" });
    if (cursor) params.set("cursor", cursor);
    const result = await adminRequest<MediaReviewPage>(`/supply/media/reviews?${params.toString()}`);
    setPage(result);
  }, [ownershipKind, state]);

  useEffect(() => {
    if (!canRead) return;
    setError(undefined);
    loadGames().catch((failure) => setError(friendlyError(failure)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, refreshNonce, loadGames]);

  useEffect(() => {
    if (!canRead) return;
    setSelected(null);
    setLoading(true);
    loadReviews()
      .catch((failure) => setError(friendlyError(failure)))
      .finally(() => setLoading(false));
  }, [canRead, loadReviews, refreshNonce]);

  const decide = async (decision: "APPROVE" | "REJECT" | "QUARANTINE", visibility: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW") => {
    if (!selected) return;
    setError(undefined);
    setSuccess(undefined);
    if (decision !== "APPROVE" && reason.trim().length < 2) {
      setError("驳回或隔离必须填写具体原因。");
      return;
    }
    setLoading(true);
    try {
      await adminRequest(`/supply/media/${selected.id}/review`, {
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        visibility,
      });
      setSuccess(`素材已${decision === "APPROVE" ? "通过" : decision === "REJECT" ? "驳回" : "隔离"}。`);
      setReason("");
      setSelected(null);
      const updated = await loadReviews();
      void updated;
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const changeVisibility = async (visibility: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW") => {
    if (!selected) return;
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest(`/supply/media/${selected.id}/visibility`, { visibility, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setSuccess(visibility === "PUBLIC_DISPLAY" ? "已设为公开展示。" : "已撤销公开；旧访问路径在本地适配器中立即失效。");
      setSelected(null);
      await loadReviews();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const bindCover = async () => {
    if (!selected) return;
    setError(undefined);
    setLoading(true);
    try {
      await adminRequest(`/supply/games/${selected.gameId}/cover`, { mediaId: selected.id }, "PUT");
      setSuccess("已设为该游戏封面；公共目录将展示审核通过的封面。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const upload = async () => {
    if (!uploadFile || !uploadGameId) {
      setError("请选择游戏与图片文件。");
      return;
    }
    setError(undefined);
    setSuccess(undefined);
    if (uploadFile.size > 10 * 1024 * 1024) {
      setError("单文件不能超过 10 MiB。");
      return;
    }
    setLoading(true);
    try {
      const intent = await adminRequest<{ intentId: string; uploadToken: string }>("/supply/media/upload-intents", {
        gameId: uploadGameId,
        purpose: uploadPurpose,
        mime: uploadFile.type,
        size: uploadFile.size,
      });
      const response = await fetch(`/api/bff/admin/supply/media/uploads/${intent.intentId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": uploadFile.type, "x-upload-token": intent.uploadToken, "idempotency-key": `idem_${crypto.randomUUID().replaceAll("-", "")}` },
        body: uploadFile,
      });
      const payload = await response.json().catch(() => null) as (UploadedAssetResponse & { error?: { code?: string } }) | null;
      if (!response.ok) {
        setError(payload?.error?.code === "INVALID_ARGUMENT" ? "文件内容与声明的图片类型不一致，或尺寸超出边界。" : "上传未完成，请检查文件与权限后重试。");
        return;
      }
      setUploadFile(null);
      setSuccess("素材已上传并进入待审核；默认私有，审核通过后才可公开。");
      await loadReviews();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  if (!canRead) {
    return <section className="section-panel"><StatusMessage error="当前账号没有媒体审核读取权限；目录维护权限不等于可查看私有凭证。" /></section>;
  }

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>平台素材审核</h3>
            <p>平台目录素材与用户凭证分开归属；上传默认私有，只有审核通过且用途允许的素材才能公开。公共转私有会清除目录绑定并撤销旧访问。</p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">审核状态</span>
            <select value={state} onChange={(event) => setState(event.target.value as MediaAssetReview["reviewState"])} className={selectClass}>
              {Object.entries(STATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">归属</span>
            <select value={ownershipKind} onChange={(event) => setOwnershipKind(event.target.value as "PLATFORM_CATALOG" | "USER_SUPPLY")} className={selectClass}>
              <option value="PLATFORM_CATALOG">平台目录素材</option>
              <option value="USER_SUPPLY">用户供给材料（私有）</option>
            </select>
          </label>
        </div>
        <StatusMessage error={error} success={success} className="mt-3" />
      </section>

      {canUpload ? (
        <section className="section-panel">
          <h3 className="text-sm font-semibold">上传平台素材</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">游戏</span>
              <select value={uploadGameId} onChange={(event) => setUploadGameId(event.target.value)} className={selectClass}>
                {games.length === 0 ? <option value="">请先创建游戏</option> : null}
                {games.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">用途</span>
              <select value={uploadPurpose} onChange={(event) => setUploadPurpose(event.target.value as "GAME_COVER" | "SKIN_MEDIA" | "ITEM_MEDIA")} className={selectClass}>
                <option value="GAME_COVER">游戏封面</option>
                <option value="SKIN_MEDIA">皮肤图</option>
                <option value="ITEM_MEDIA">物品图</option>
              </select>
            </label>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">图片（JPEG/PNG/WebP，≤10 MiB）</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} className={inputClass} />
            </label>
          </div>
          <div className="mt-3"><Button type="button" size="sm" loading={loading} onClick={() => void upload()}>上传并进入待审</Button></div>
        </section>
      ) : null}

      <section className="section-panel">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">审核队列</h3>
          <span className="text-[11px] text-muted-foreground">{page?.items.length ?? 0} 条 · {STATE_LABELS[state]}</span>
        </div>
        {page && page.items.length > 0 ? (
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead><tr><th>预览</th><th>游戏</th><th>用途</th><th>上传者</th><th>尺寸</th><th>状态</th><th>原因</th><th /></tr></thead>
              <tbody>
                {page.items.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <img
                        src={`/api/bff/admin/supply/media/${asset.id}/content`}
                        alt={`素材 ${asset.id}`}
                        className="w-16 h-16 object-cover rounded border border-border"
                        loading="lazy"
                      />
                    </td>
                    <td>{gameNames.get(asset.gameId) ?? asset.gameId}</td>
                    <td>{PURPOSE_LABELS[asset.purpose]}</td>
                    <td>{asset.uploadedByRealm === "admin" ? "管理员" : "用户"} · {asset.uploadedByAdminId ?? asset.uploadedByUserId ?? "-"}</td>
                    <td className="font-mono text-[11px]">{asset.width}×{asset.height} · {asset.byteSize}B</td>
                    <td>{STATE_LABELS[asset.reviewState]}{asset.accessClass === "PUBLIC_DISPLAY" ? " · 公开" : " · 私有"}</td>
                    <td className="max-w-xs text-[11px] text-muted-foreground">{asset.reviewReason ?? ""}</td>
                    <td><Button type="button" size="sm" variant="secondary" onClick={() => setSelected(asset)}>审核</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-6 text-center">{loading ? "加载中…" : "当前筛选下没有素材。"}</p>
        )}
        <div className="flex justify-end mt-4">
          <Button type="button" size="sm" variant="secondary" disabled={!page?.nextCursor || loading} onClick={() => { if (page?.nextCursor) void loadReviews(page.nextCursor); }}>下一页</Button>
        </div>
      </section>

      {selected ? (
        <section className="section-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">审核素材</h3>
              <p className="text-[11px] text-muted-foreground mt-1">{selected.id} · {PURPOSE_LABELS[selected.purpose]} · {selected.reviewState} · 内容 hash {selected.contentHash.slice(0, 16)}…</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(null)}>关闭</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <img src={`/api/bff/admin/supply/media/${selected.id}/content`} alt="素材预览" className="max-h-80 object-contain rounded border border-border bg-surface-raised" />
            <div className="space-y-3">
              <label className="space-y-1 text-xs block"><span className="text-muted-foreground">原因（驳回 / 隔离必填）</span><input value={reason} onChange={(event) => setReason(event.target.value)} className={inputClass} /></label>
              {canDecide ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" loading={loading} onClick={() => void decide("APPROVE", selected.ownershipKind === "PLATFORM_CATALOG" ? "PUBLIC_DISPLAY" : "PRIVATE_REVIEW")}>通过{selected.ownershipKind === "PLATFORM_CATALOG" ? "并公开" : "（保持私有）"}</Button>
                  <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void decide("APPROVE", "PRIVATE_REVIEW")}>通过但保持私有</Button>
                  <Button type="button" size="sm" variant="danger" loading={loading} onClick={() => void decide("REJECT", "PRIVATE_REVIEW")}>驳回</Button>
                  <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void decide("QUARANTINE", "PRIVATE_REVIEW")}>隔离</Button>
                </div>
              ) : <StatusMessage error="当前账号可以查看但不能决定审核。" />}
              {canDecide && selected.reviewState === "APPROVED" ? (
                <div className="flex flex-wrap gap-2">
                  {selected.accessClass === "PRIVATE_REVIEW" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void changeVisibility("PUBLIC_DISPLAY")}>恢复公开展示</Button> : null}
                  {selected.accessClass === "PUBLIC_DISPLAY" ? <Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void changeVisibility("PRIVATE_REVIEW")}>撤销公开</Button> : null}
                  {selected.ownershipKind === "PLATFORM_CATALOG" && selected.purpose === "GAME_COVER" && selected.accessClass === "PUBLIC_DISPLAY" ? (
                    <Button type="button" size="sm" loading={loading} onClick={() => void bindCover()}>设为游戏封面</Button>
                  ) : null}
                </div>
              ) : null}
              <p className="text-[11px] text-muted-foreground">审核权限与对象范围在服务端校验；此面板不显示存储键或迁移原文。</p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
