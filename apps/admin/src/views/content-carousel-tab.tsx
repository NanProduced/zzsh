import { useEffect, useRef, useState } from "react";

import {
  adminRequest,
  formatDate,
  friendlyError,
  type CarouselPage,
  type CarouselRow,
  type ContentMediaOptionsPage,
} from "../api";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { CarouselEditor } from "./content-carousel-editor";

export function CarouselTab({
  canEdit,
  canPublish,
  mediaReadable,
  refreshNonce,
  onDirtyChange,
  requestMediaOptions,
}: {
  canEdit: boolean;
  canPublish: boolean;
  mediaReadable: boolean;
  refreshNonce: number;
  onDirtyChange: (dirty: boolean) => void;
  requestMediaOptions: (cursor: string | null) => Promise<ContentMediaOptionsPage>;
}) {
  const [page, setPage] = useState<CarouselPage | null>(null);
  const [selected, setSelected] = useState<CarouselRow | "new" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const listSeq = useRef(0);

  const load = async (cursor?: string) => {
    const seq = ++listSeq.current;
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ slot: "HOME_HERO", limit: "20" });
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<CarouselPage>(`/content/carousel?${params.toString()}`);
      if (seq !== listSeq.current) return;
      setPage(result);
      setSelected((current) => (current && current !== "new" ? result.items.find((entry) => entry.id === current.id) ?? current : current));
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

  return (
    <div className="space-y-5">
      <section className="section-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">首页固定槽位轮播</h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              仅启用、在展示时间内且图片已审核公开的条目会显示在首页；图片撤权后自动隐藏。
            </p>
          </div>
          {canEdit ? <Button type="button" size="sm" onClick={() => setSelected("new")}>新建轮播条目</Button> : null}
        </div>
        <StatusMessage error={error} className="mt-3" />
        {page && page.items.length > 0 ? (
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead><tr><th>预览</th><th>标题</th><th>跳转</th><th>时间范围</th><th>排序</th><th>状态</th><th /></tr></thead>
              <tbody>
                {page.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {mediaReadable ? (
                        <img src={`/api/bff/admin/content/media/${entry.mediaId}/content`} alt={entry.imageAlt} className="w-20 h-12 object-cover rounded border border-border" loading="lazy" />
                      ) : <span className="text-[11px] text-muted-foreground">{entry.mediaId}</span>}
                    </td>
                    <td className="max-w-xs">
                      <span className="block truncate">{entry.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{entry.imageAlt}</span>
                    </td>
                    <td className="font-mono text-[11px]">{entry.linkUrl ?? "无跳转"}</td>
                    <td className="text-[11px]">{entry.startsAt ? formatDate(entry.startsAt) : "立即"} → {entry.endsAt ? formatDate(entry.endsAt) : "长期"}</td>
                    <td className="font-mono text-[11px]">{entry.sortOrder}</td>
                    <td>
                      {entry.enabled ? "启用" : "停用"}
                      {entry.mediaReviewState === "APPROVED" && entry.mediaAccessClass === "PUBLIC_DISPLAY" ? " · 素材公开" : " · 素材不可公开"}
                    </td>
                    <td><Button type="button" size="sm" variant="secondary" onClick={() => setSelected(entry)}>{canEdit ? "编辑" : "查看"}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-6 text-center">{loading ? "加载中…" : "当前槽位没有轮播条目。"}</p>
        )}
        <div className="flex justify-end mt-4">
          <Button type="button" size="sm" variant="secondary" disabled={!page?.nextCursor || loading} onClick={() => { if (page?.nextCursor) void load(page.nextCursor); }}>下一页</Button>
        </div>
      </section>

      {selected ? (
        <CarouselEditor
          key={selected === "new" ? "new" : `${selected.id}:${selected.revision}`}
          selected={selected}
          canEdit={canEdit}
          canPublish={canPublish}
          mediaReadable={mediaReadable}
          onClose={() => setSelected(null)}
          onChanged={async () => { await load(); }}
          onDirtyChange={onDirtyChange}
          requestMediaOptions={requestMediaOptions}
        />
      ) : null}
    </div>
  );
}

