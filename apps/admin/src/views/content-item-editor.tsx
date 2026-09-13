import { useEffect, useMemo, useRef, useState } from "react";

import {
  adminRequest,
  AdminApiError,
  formatDate,
  friendlyError,
  type ContentGame,
  type ContentItemDetail,
  type ContentItemRow,
  type ContentMediaOption,
  type ContentMediaOptionsPage,
} from "../api";
import { Button, StatusMessage } from "../components/ui-elements";

const inputClass = "w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs";
const textAreaClass = "w-full min-h-40 px-3 py-2 rounded border border-border bg-surface-raised text-xs leading-relaxed";

export function itemStateLabel(item: ContentItemRow): string {
  if (item.published) return "已发布";
  if (item.draft) return "草稿";
  if (item.latest) return "已撤回";
  return "未发布";
}

export function ItemEditor({
  detail,
  games,
  canEdit,
  canPublish,
  mediaReadable,
  onClose,
  onChanged,
  onDirtyChange,
  requestMediaOptions,
}: {
  detail: ContentItemDetail;
  games: ContentGame[];
  canEdit: boolean;
  canPublish: boolean;
  mediaReadable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  requestMediaOptions: (cursor: string | null) => Promise<ContentMediaOptionsPage>;
}) {
  const item = detail.item;
  const draft = item.draft;
  const published = item.published;
  const [model, setModel] = useState(() => ({
    title: draft?.title ?? published?.title ?? "",
    summary: draft?.summary ?? published?.summary ?? "",
    body: draft?.body ?? published?.body ?? "",
    coverMediaId: draft?.coverMediaId ?? published?.coverMediaId ?? null,
  }));
  const [sortOrder, setSortOrder] = useState(String(item.sortOrder));
  const [baseline, setBaseline] = useState(() => JSON.stringify(model));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [preview, setPreview] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<ContentMediaOption[]>([]);
  const [optionsCursor, setOptionsCursor] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string>();
  const pickerSeq = useRef(0);
  const scopeGames = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);

  useEffect(() => {
    onDirtyChange(JSON.stringify(model) !== baseline);
  }, [baseline, model, onDirtyChange]);
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

  const togglePicker = () => {
    const next = !pickerOpen;
    setPickerOpen(next);
    if (next) {
      void loadOptions(null);
    } else {
      pickerSeq.current += 1;
    }
  };

  const run = async (action: () => Promise<void>, successText: string, conflictText?: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await action();
      setSuccess(successText);
      await onChanged();
    } catch (failure) {
      setError(conflictText && failure instanceof AdminApiError && failure.code === "CONFLICT" ? conflictText : friendlyError(failure));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    const snapshot = JSON.stringify(model);
    void run(async () => {
      // Version identity is sent explicitly: a stale editor can not save into a
      // replacement draft that happens to share the same per-version revision.
      await adminRequest(
        `/content/items/${item.id}/draft`,
        { versionId: draft.id, expectedRevision: draft.revision, title: model.title, summary: model.summary, body: model.body, coverMediaId: model.coverMediaId },
        "PUT",
      );
      setBaseline(snapshot);
    }, "草稿已保存；线上发布版本未改变。", "草稿已被其他会话更新或替换：请关闭后重新打开最新版本再保存；当前输入已保留，未自动覆盖。");
  };

  const createDraft = () => {
    void run(async () => {
      await adminRequest(`/content/items/${item.id}/draft`, {});
    }, "已从当前版本创建新草稿；修改不会影响线上正文。");
  };

  const publish = () => {
    if (!draft) return;
    if (draft.title.trim().length === 0) {
      setError("当前草稿标题为空：发布要求标题非空，请填写标题并先保存草稿，再发布。");
      return;
    }
    const snapshot = JSON.stringify(model);
    void run(async () => {
      await adminRequest(`/content/items/${item.id}/publish`, { versionId: draft.id, expectedRevision: draft.revision });
      setBaseline(snapshot);
    }, "已发布为当前线上版本。");
  };

  const withdraw = () => {
    if (!published || !window.confirm("撤回后公共接口立即不可读，历史版本保留。确定撤回？")) return;
    void run(async () => {
      await adminRequest(`/content/items/${item.id}/withdraw`, { versionId: published.id, expectedRevision: item.revision });
    }, "已撤回；公共接口不再返回该内容。");
  };

  const saveSort = () => {
    const parsed = Number(sortOrder);
    if (!Number.isInteger(parsed)) {
      setError("排序必须是整数。");
      return;
    }
    void run(async () => {
      await adminRequest(`/content/items/${item.id}`, { expectedRevision: item.revision, sortOrder: parsed }, "PUT");
    }, "排序已更新。");
  };

  const readOnly = !canEdit;
  return (
    <section className="section-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {item.type === "ANNOUNCEMENT" ? "公告编辑" : "资讯编辑"}
            <span className="ml-2 text-[11px] font-normal text-muted-foreground">
              {item.gameId === null ? "平台级" : scopeGames.get(item.gameId) ?? item.gameId} · {item.id}
            </span>
          </h3>
          <p className="text-[11px] text-muted-foreground mt-1">
            当前状态：{itemStateLabel(item)}
            {published ? ` · 线上版本 v${published.sequence}` : " · 无线上版本"}
            {draft ? ` · 草稿 v${draft.sequence}` : " · 无草稿"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setPreview((value) => !value)}>{preview ? "关闭预览" : "预览"}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </div>
      </div>

      <StatusMessage error={error} success={success} className="mt-3" />

      {preview ? (
        <article className="mt-4 rounded border border-border bg-surface-raised p-5 max-w-3xl">
          <h4 className="text-lg font-semibold">{model.title || "（无标题）"}</h4>
          {model.summary ? <p className="text-xs text-muted-foreground mt-2">{model.summary}</p> : null}
          {model.coverMediaId && mediaReadable ? (
            <img src={`/api/bff/admin/content/media/${model.coverMediaId}/content`} alt={model.title || "封面"} className="mt-4 max-h-72 object-contain rounded border border-border" />
          ) : null}
          <p className="text-sm leading-relaxed mt-4 whitespace-pre-wrap">{model.body || "（无正文）"}</p>
          <p className="text-[11px] text-muted-foreground mt-4 border-t border-border pt-3">预览只反映当前编辑内容，不代表已发布。</p>
        </article>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <label className="space-y-1 text-xs lg:col-span-2">
          <span className="text-muted-foreground">标题（≤200 字，纯文本）</span>
          <input value={model.title} onChange={(event) => setModel((current) => ({ ...current, title: event.target.value }))} className={inputClass} disabled={readOnly} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">排序（越大越靠前）</span>
          <div className="flex gap-2">
            <input value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} className={inputClass} inputMode="numeric" disabled={readOnly} />
            <Button type="button" size="sm" variant="secondary" loading={busy} disabled={readOnly} onClick={saveSort}>保存排序</Button>
          </div>
        </label>
        <label className="space-y-1 text-xs lg:col-span-3">
          <span className="text-muted-foreground">摘要（≤500 字，列表展示）</span>
          <input value={model.summary} onChange={(event) => setModel((current) => ({ ...current, summary: event.target.value }))} className={inputClass} disabled={readOnly} />
        </label>
        <label className="space-y-1 text-xs lg:col-span-3">
          <span className="text-muted-foreground">正文（纯文本 ≤20000 字节；换行保留，不执行 HTML）</span>
          <textarea value={model.body} onChange={(event) => setModel((current) => ({ ...current, body: event.target.value }))} className={textAreaClass} disabled={readOnly} />
        </label>
        <div className="space-y-2 text-xs lg:col-span-3">
          <span className="text-muted-foreground">封面（平台内容素材；未审核或已撤权素材发布会失败）</span>
          <div className="flex flex-wrap items-center gap-3">
            {model.coverMediaId ? (
              mediaReadable ? (
                <img src={`/api/bff/admin/content/media/${model.coverMediaId}/content`} alt="封面预览" className="w-24 h-16 object-cover rounded border border-border" />
              ) : <span className="text-[11px] text-muted-foreground">封面 {model.coverMediaId}</span>
            ) : <span className="text-[11px] text-muted-foreground">未选择封面</span>}
            <Button type="button" size="sm" variant="secondary" disabled={readOnly} onClick={togglePicker}>{pickerOpen ? "收起素材" : "选择封面"}</Button>
            {model.coverMediaId ? <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={() => setModel((current) => ({ ...current, coverMediaId: null }))}>移除封面</Button> : null}
          </div>
          {pickerOpen ? (
            <div className="rounded border border-border p-3">
              <StatusMessage error={optionsError} className="mb-2" />
              {optionsLoading && options.length === 0 ? <p className="text-[11px] text-muted-foreground">加载候选素材…</p> : null}
              {!optionsLoading && !optionsError && options.length === 0 ? <p className="text-[11px] text-muted-foreground">暂无已审核公开的平台内容素材，请先在“平台素材”上传并审核。</p> : null}
              <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => { setModel((current) => ({ ...current, coverMediaId: option.id })); setPickerOpen(false); }}
                    className="w-24 rounded border border-border overflow-hidden text-left hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <img src={`/api/bff/admin/content/media/${option.id}/content`} alt={`素材 ${option.id}`} className="w-full h-16 object-cover" loading="lazy" />
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
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-4">
        {draft ? <Button type="button" size="sm" loading={busy} disabled={readOnly} onClick={saveDraft}>保存草稿</Button> : null}
        {published && !draft ? <Button type="button" size="sm" variant="secondary" loading={busy} disabled={readOnly} onClick={createDraft}>编辑已发布内容（新建草稿）</Button> : null}
        {draft && canPublish ? <Button type="button" size="sm" loading={busy} onClick={publish}>发布草稿 v{draft.sequence}</Button> : null}
        {published && canPublish ? <Button type="button" size="sm" variant="danger" loading={busy} onClick={withdraw}>撤回线上版本</Button> : null}
        {!canEdit ? <span className="text-[11px] text-muted-foreground self-center">当前账号只能查看。</span> : null}
      </div>

      <details className="mt-5">
        <summary className="text-xs text-muted-foreground cursor-pointer select-none">版本历史（{detail.versions.length}）</summary>
        <div className="table-wrap mt-3">
          <table className="data-table">
            <thead><tr><th>版本</th><th>状态</th><th>标题</th><th>修订</th><th>发布时间</th></tr></thead>
            <tbody>
              {detail.versions.map((version) => (
                <tr key={version.id}>
                  <td className="font-mono text-[11px]">v{version.sequence}</td>
                  <td>{version.state === "PUBLISHED" ? "线上" : version.state === "DRAFT" ? "草稿" : version.state === "SUPERSEDED" ? "历史" : "已撤回"}</td>
                  <td>{version.title || "（无标题）"}</td>
                  <td className="font-mono text-[11px]">{version.revision}</td>
                  <td>{version.publishedAt ? formatDate(version.publishedAt) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
