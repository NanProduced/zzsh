import { useEffect, useRef, useState } from "react";

import {
  adminRequest,
  formatDate,
  friendlyError,
  type CarouselPage,
  type CarouselRow,
  type ContentMediaOption,
  type ContentMediaOptionsPage,
} from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const textAreaClass = "w-full min-h-24 px-3 py-2 rounded border border-border bg-surface-raised text-xs leading-relaxed";

function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

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
              槽位 HOME_HERO 为当前首页主轮播。仅启用、在起止时间内且素材已审核公开的条目会被公共接口返回；撤权素材的条目自动隐藏。
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

function CarouselEditor({
  selected,
  canEdit,
  canPublish,
  mediaReadable,
  onClose,
  onChanged,
  onDirtyChange,
  requestMediaOptions,
}: {
  selected: CarouselRow | "new";
  canEdit: boolean;
  canPublish: boolean;
  mediaReadable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  requestMediaOptions: (cursor: string | null) => Promise<ContentMediaOptionsPage>;
}) {
  const existing = selected === "new" ? null : selected;
  const [model, setModel] = useState(() => ({
    mediaId: existing?.mediaId ?? (null as string | null),
    imageAlt: existing?.imageAlt ?? "",
    title: existing?.title ?? "",
    description: existing?.description ?? "",
    linkUrl: existing?.linkUrl ?? "",
    sortOrder: existing?.sortOrder ?? 0,
    startsAt: toLocalInput(existing?.startsAt ?? null),
    endsAt: toLocalInput(existing?.endsAt ?? null),
    enabled: existing?.enabled ?? false,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<ContentMediaOption[]>([]);
  const [optionsCursor, setOptionsCursor] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string>();
  const pickerSeq = useRef(0);
  const baseline = useRef(JSON.stringify(model));

  useEffect(() => {
    onDirtyChange(JSON.stringify(model) !== baseline.current);
  }, [model, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const loadOptions = async (cursor: string | null) => {
    if (!cursor) {
      setOptions([]);
      setOptionsCursor(null);
    }
    setOptionsError(undefined);
    setOptionsLoading(true);
    const seq = ++pickerSeq.current;
    try {
      const result = await requestMediaOptions(cursor);
      if (seq !== pickerSeq.current) return;
      setOptions((current) => (cursor ? [...current, ...result.items] : result.items));
      setOptionsCursor(result.nextCursor);
    } catch (failure) {
      if (seq !== pickerSeq.current) return;
      setOptionsError(friendlyError(failure));
    } finally {
      if (seq === pickerSeq.current) setOptionsLoading(false);
    }
  };

  const run = async (action: () => Promise<void>, successText: string) => {
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await action();
      setSuccess(successText);
      await onChanged();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const payload = {
      mediaId: model.mediaId,
      imageAlt: model.imageAlt,
      title: model.title,
      description: model.description,
      linkUrl: model.linkUrl.trim() === "" ? null : model.linkUrl,
      sortOrder: Number(model.sortOrder),
      startsAt: fromLocalInput(model.startsAt),
      endsAt: fromLocalInput(model.endsAt),
      enabled: model.enabled,
    };
    if (!payload.mediaId) {
      setError("请选择轮播图片素材。");
      return;
    }
    if (!payload.title.trim() || !payload.imageAlt.trim()) {
      setError("标题与无障碍图片说明为必填。");
      return;
    }
    if (!Number.isInteger(payload.sortOrder)) {
      setError("排序必须是整数。");
      return;
    }
    if (requiresPublish && !canPublish) {
      setError("该操作会创建、启用、停用或修改已公开轮播，需要内容发布权限。");
      return;
    }
    const snapshot = JSON.stringify(model);
    void run(async () => {
      if (existing) {
        await adminRequest(`/content/carousel/${existing.id}`, { expectedRevision: existing.revision, ...payload }, "PUT");
      } else {
        await adminRequest("/content/carousel", { slotCode: "HOME_HERO", ...payload });
      }
      baseline.current = snapshot;
    }, existing ? "轮播条目已保存。" : "轮播条目已创建；默认停用，可启用后对外展示。");
  };

  // Mirrors the server decision for UX only; the server re-checks under the
  // row lock. An enable/disable transition and any save of an enabled entry are
  // publish actions, so edit-only operators cannot reach them from the form.
  const requiresPublish = existing
    ? model.enabled !== existing.enabled || model.enabled
    : model.enabled;
  const readOnly = !canEdit;
  return (
    <section className="section-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{existing ? "编辑轮播条目" : "新建轮播条目"}<span className="ml-2 text-[11px] font-normal text-muted-foreground">HOME_HERO</span></h3>
          <p className="text-[11px] text-muted-foreground mt-1">
            跳转只允许站内已实现路径（/、/accounts、/publish、/account、/help）；开始时间包含、结束时间不包含，由服务端按 UTC 判断。
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => { setPickerOpen((value) => !value); if (!pickerOpen) void loadOptions(null); }}>{pickerOpen ? "收起素材" : "选择图片"}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </div>
      </div>
      <StatusMessage error={error} success={success} className="mt-3" />
      {pickerOpen ? (
        <div className="rounded border border-border p-3 mt-3">
          <StatusMessage error={optionsError} className="mb-2" />
          {optionsLoading && options.length === 0 ? <p className="text-[11px] text-muted-foreground">加载候选素材…</p> : null}
          {!optionsLoading && !optionsError && options.length === 0 ? <p className="text-[11px] text-muted-foreground">暂无已审核公开的平台内容素材。</p> : null}
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => { setModel((current) => ({ ...current, mediaId: option.id })); setPickerOpen(false); }}
                className={`w-24 rounded border overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${model.mediaId === option.id ? "border-foreground" : "border-border"}`}
              >
                <img src={`/api/bff/admin/content/media/${option.id}/content`} alt={`素材 ${option.id}`} className="w-full h-14 object-cover" loading="lazy" />
                <span className="block px-1 py-0.5 text-[10px] text-muted-foreground truncate">{option.id}</span>
              </button>
            ))}
          </div>
          {optionsError ? (
            <div className="mt-2"><Button type="button" size="sm" variant="secondary" loading={optionsLoading} onClick={() => void loadOptions(null)}>重试</Button></div>
          ) : optionsCursor ? (
            <div className="mt-2"><Button type="button" size="sm" variant="secondary" loading={optionsLoading} onClick={() => void loadOptions(optionsCursor)}>加载更多</Button></div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div className="space-y-2 text-xs">
          <span className="text-muted-foreground">图片素材</span>
          {model.mediaId ? (
            mediaReadable ? <img src={`/api/bff/admin/content/media/${model.mediaId}/content`} alt="轮播预览" className="w-full max-h-48 object-contain rounded border border-border bg-surface-raised" /> : <span className="text-[11px]">{model.mediaId}</span>
          ) : <span className="text-[11px] text-muted-foreground">未选择</span>}
        </div>
        <div className="space-y-3">
          <label className="space-y-1 text-xs block"><span className="text-muted-foreground">标题（≤120 字）</span><input value={model.title} onChange={(event) => setModel((current) => ({ ...current, title: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
          <label className="space-y-1 text-xs block"><span className="text-muted-foreground">图片说明 / 无障碍文本（≤300 字）</span><input value={model.imageAlt} onChange={(event) => setModel((current) => ({ ...current, imageAlt: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
          <label className="space-y-1 text-xs block"><span className="text-muted-foreground">补充说明（≤300 字）</span><textarea value={model.description} onChange={(event) => setModel((current) => ({ ...current, description: event.target.value }))} className={textAreaClass} disabled={readOnly} /></label>
          <label className="space-y-1 text-xs block"><span className="text-muted-foreground">站内跳转（可空，例如 /accounts?tab=new）</span><input value={model.linkUrl} onChange={(event) => setModel((current) => ({ ...current, linkUrl: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs block"><span className="text-muted-foreground">开始（本地时间）</span><input type="datetime-local" value={model.startsAt} onChange={(event) => setModel((current) => ({ ...current, startsAt: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
            <label className="space-y-1 text-xs block"><span className="text-muted-foreground">结束（本地时间，不含）</span><input type="datetime-local" value={model.endsAt} onChange={(event) => setModel((current) => ({ ...current, endsAt: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">排序</span><input value={model.sortOrder} onChange={(event) => setModel((current) => ({ ...current, sortOrder: Number(event.target.value) || 0 }))} className={inputClass} inputMode="numeric" disabled={readOnly} /></label>
            <label className="flex items-center gap-2 text-xs mt-4">
              <input type="checkbox" checked={model.enabled} onChange={(event) => setModel((current) => ({ ...current, enabled: event.target.checked }))} disabled={readOnly || !canPublish} />
              <span>启用展示（素材必须已审核公开；启用/停用需要发布权限）</span>
            </label>
          </div>
          {!canPublish && canEdit ? (
            <p className="text-[11px] text-muted-foreground">你没有内容发布权限：可以维护未启用草稿，但启用/停用和修改已公开轮播会被服务端拒绝。</p>
          ) : null}
          {canEdit ? (
            <Button type="button" size="sm" loading={busy} disabled={!canPublish && requiresPublish} onClick={save}>
              {existing ? "保存轮播条目" : "创建轮播条目"}
            </Button>
          ) : <span className="text-[11px] text-muted-foreground">当前账号只能查看。</span>}
        </div>
      </div>
    </section>
  );
}
