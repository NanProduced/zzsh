import { useEffect, useRef, useState } from "react";
import { adminRequest, friendlyError, type CarouselRow, type ContentMediaOption, type ContentMediaOptionsPage } from "../api";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

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

export function CarouselEditor({
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
          <h3 className="text-sm font-semibold">{existing ? "编辑轮播条目" : "新建轮播条目"}</h3>
          <p className="text-[11px] text-muted-foreground mt-1">
            跳转只支持站内指定页面（/、/accounts、/publish、/account、/help）；从开始时间起展示，至结束时间停止，按 UTC 时间计算。
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
          <label className="space-y-1 text-xs block"><span className="text-muted-foreground">补充说明（≤300 字）</span><Textarea value={model.description} onChange={(event) => setModel((current) => ({ ...current, description: event.target.value }))} className="min-h-20 text-xs" disabled={readOnly} /></label>
          <label className="space-y-1 text-xs block"><span className="text-muted-foreground">站内跳转（可空，例如 /accounts?tab=new）</span><input value={model.linkUrl} onChange={(event) => setModel((current) => ({ ...current, linkUrl: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs block"><span className="text-muted-foreground">开始（本地时间）</span><input type="datetime-local" value={model.startsAt} onChange={(event) => setModel((current) => ({ ...current, startsAt: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
            <label className="space-y-1 text-xs block"><span className="text-muted-foreground">结束（本地时间，不含）</span><input type="datetime-local" value={model.endsAt} onChange={(event) => setModel((current) => ({ ...current, endsAt: event.target.value }))} className={inputClass} disabled={readOnly} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">排序</span><input value={model.sortOrder} onChange={(event) => setModel((current) => ({ ...current, sortOrder: Number(event.target.value) || 0 }))} className={inputClass} inputMode="numeric" disabled={readOnly} /></label>
            <label className="flex items-center gap-2 text-xs mt-4 cursor-pointer select-none">
              <Checkbox checked={model.enabled} onCheckedChange={(checked) => setModel((current) => ({ ...current, enabled: checked === true }))} disabled={readOnly || !canPublish} />
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
