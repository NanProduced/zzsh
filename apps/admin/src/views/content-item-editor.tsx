import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Send, ShieldAlert } from "lucide-react";
import { updateSettings, plainTextMarkdown, checkUpdatePublication } from '@zzsh/content/updates';
import '@zzsh/ui/content-markdown.css';
import { ContentUpdateSettings, updateExposureFacts } from './content-update-settings';
import { ContentMediaField } from './content-resource-fields';
import { contentTime } from './content-resources-model';
const MarkdownInput = lazy(() => import('./content-markdown-input'));
const MarkdownDocument = lazy(() => import('@zzsh/ui/content-markdown').then(module => ({ default: module.MarkdownDocument })));

import {
  adminRequest,
  AdminApiError,
  friendlyError,
  type ContentGame,
  type ContentItemDetail,
  type ContentItemRow,
  type ContentMediaOption,
  type ContentMediaOptionsPage,
} from "../api";
import { Badge } from "../components/ui/badge";
import { Button, StatusMessage } from "../components/ui-elements";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

const textAreaClass = "w-full min-h-40 px-3 py-2 rounded border border-border bg-surface-raised text-xs leading-relaxed";
type WithdrawalTarget = { itemId: string; versionId: string; expectedRevision: string };
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
const byteLabel = (value: string, max: number) => `${utf8Bytes(value)} / ${max} 字节`;

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
  canPublishPlatform = false,
  mediaReadable,
  onClose,
  onChanged,
  onDirtyChange,
  onWriteLockChange,
  requestMediaOptions,
  onReload,
  onSuccess,
  reading = false,
}: {
  detail: ContentItemDetail;
  games: ContentGame[];
  canEdit: boolean;
  canPublish: boolean;
  canPublishPlatform?: boolean;
  mediaReadable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
  requestMediaOptions: (cursor: string | null) => Promise<ContentMediaOptionsPage>;
  onReload?: () => void;
  onSuccess?: (message: string) => void;
  reading?: boolean;
}) {
  const item = detail.item;
  const draft = item.draft;
  const published = item.published;
  const source = draft ?? published ?? detail.versions[0];
  const [model, setModel] = useState(() => ({
    title: source?.title ?? "",
    summary: source?.summary ?? "",
    body: source?.body ?? "",
    coverMediaId: source?.coverMediaId ?? null,
    updateSettings: updateSettings(source?.updateSettings ?? {}),
  }));
  const [diagnostic, setDiagnostic] = useState<string>(), [checking, setChecking] = useState(false);
  const promotionDiagnostic = item.gameId && model.updateSettings.tickerEnabled && !canPublishPlatform ? '首页曝光需要平台发布权限；可保存草稿交平台运营发布，或关闭首页曝光。' : undefined;
  const [bodyMedia, setBodyMedia] = useState<Record<string, string | null>>(source?.bodyMedia ?? {}), [insertBodyMedia, setInsertBodyMedia] = useState(false);
  useEffect(() => {
    let active = true;
    setChecking(true); setDiagnostic(undefined);
    void (async () => {
      try {
        checkUpdatePublication(item.type, model.updateSettings);
        if (model.updateSettings.format === 'markdown') {
          const { inspectMarkdown } = await import('@zzsh/content/markdown');
          const media = Object.fromEntries(Object.entries(bodyMedia).map(([id, url]) => [id, { available: Boolean(url) }]));
          const result = await inspectMarkdown(model.body, { media });
          if (result.blocking) throw new Error(result.issues.filter(x => x.severity === 'blocking').map(x => `第${x.line}行：${x.message}`).slice(0, 5).join('；'));
        }
      } catch (failure) { if (active) setDiagnostic(failure instanceof Error ? failure.message : '正文检查失败'); }
      finally { if (active) setChecking(false); }
    })();
    return () => { active = false; };
  }, [model.body, model.updateSettings, item.type, bodyMedia]);
  const [sortOrder, setSortOrder] = useState(String(item.sortOrder));
  const [baseline, setBaseline] = useState(() => JSON.stringify(model));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [preview, setPreview] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [withdrawIntent, setWithdrawIntent] = useState<WithdrawalTarget | null>(null);
  const [leaveIntent, setLeaveIntent] = useState<"close" | "reload" | null>(null);
  const withdrawIntentRef = useRef<WithdrawalTarget | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const targetRef = useRef({ itemId: item.id, versionId: published?.id, expectedRevision: item.revision, canPublish });
  targetRef.current = { itemId: item.id, versionId: published?.id, expectedRevision: item.revision, canPublish };
  const cancelWithdraw = useCallback(() => { withdrawIntentRef.current = null; setWithdrawIntent(null); }, []);
  const [options, setOptions] = useState<ContentMediaOption[]>([]);
  const [optionsCursor, setOptionsCursor] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string>();
  const pickerSeq = useRef(0);
  const scopeGames = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const withdrawnVersion = detail.versions.find(version => version.state === "WITHDRAWN") ?? null;
  const stateLabel = published ? itemStateLabel(item) : draft ? (withdrawnVersion ? "已撤回 · 有草稿" : "草稿") : withdrawnVersion ? "已撤回" : itemStateLabel(item);
  const stateTone = published ? "success" : draft ? (withdrawnVersion ? "warning" : "info") : withdrawnVersion ? "warning" : "unknown";
  const titleBytes = utf8Bytes(model.title), summaryBytes = utf8Bytes(model.summary), bodyBytes = utf8Bytes(model.body);
  const overLimit = titleBytes > 200 ? "标题超过 200 字节，保存会被拒绝。" : summaryBytes > 500 ? "摘要超过 500 字节，保存会被拒绝。" : bodyBytes > 20000 ? "正文超过 20000 字节，保存会被拒绝。" : undefined;
  const exposureFacts = updateExposureFacts(published?.updateSettings);
  const readOnlyOnline = canEdit && !draft && Boolean(published);
  const readOnlyWithdrawn = canEdit && !draft && !published && Boolean(withdrawnVersion);
  const releaseHint = !canPublish ? canEdit ? "当前账号没有发布权限，可保存草稿交有对应发布权限的管理员处理。" : "当前账号只能查看，不能保存或发布。"
    : readOnlyOnline ? "线上版本只读；先创建草稿并保存，再发布。"
    : readOnlyWithdrawn ? "线上内容已撤回；从版本历史恢复或新建草稿后才能重新发布。"
    : !draft ? "没有待发布草稿；先创建并保存草稿。"
    : checking ? "正在检查正文与展示设置…"
    : diagnostic ? `处理后才能发布：${diagnostic}`
    : promotionDiagnostic ? promotionDiagnostic
    : overLimit ? overLimit
    : !model.title.trim() ? "发布要求标题非空。"
    : JSON.stringify(model) !== baseline ? "当前有未保存修改，先保存草稿再发布。"
    : "发布后用户页面立即读取这一版本；线上旧版本保留为历史。";

  useEffect(() => {
    onDirtyChange(JSON.stringify(model) !== baseline);
  }, [baseline, model, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => { onWriteLockChange?.(busy); }, [busy, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);
  useEffect(() => {
    const pending = withdrawIntentRef.current;
    if (pending && (busy || !canPublish || pending.itemId !== item.id || pending.versionId !== published?.id || pending.expectedRevision !== item.revision)) cancelWithdraw();
  }, [busy, canPublish, cancelWithdraw, item.id, item.revision, published?.id]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; withdrawIntentRef.current = null; };
  }, []);

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
    if (busyRef.current || reading) return;
    busyRef.current = true;
    cancelWithdraw();
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await action();
      setSuccess(successText);
      onSuccess?.(successText);
      await onChanged();
    } catch (failure) {
      setError(conflictText && failure instanceof AdminApiError && failure.code === "CONFLICT" ? conflictText : friendlyError(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    if (overLimit) { setError(overLimit); return; }
    const snapshot = JSON.stringify(model);
    void run(async () => {
      // Version identity is sent explicitly: a stale editor can not save into a
      // replacement draft that happens to share the same per-version revision.
      await adminRequest(
        `/content/items/${item.id}/draft`,
        { versionId: draft.id, expectedRevision: draft.revision, title: model.title, summary: model.summary, body: model.body, coverMediaId: model.coverMediaId, updateSettings: model.updateSettings },
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
    if (checking || diagnostic || promotionDiagnostic || overLimit || JSON.stringify(model) !== baseline) { setError(diagnostic || promotionDiagnostic || overLimit || '请先保存当前草稿并完成正文检查，再发布。'); return; }
    if (draft.title.trim().length === 0) {
      setError("当前草稿标题为空：发布要求标题非空，请填写标题并先保存草稿，再发布。");
      return;
    }
    const snapshot = JSON.stringify(model);
    void run(async () => {
      await adminRequest(`/content/items/${item.id}/publish`, { versionId: draft.id, expectedRevision: draft.revision });
      setBaseline(snapshot);
    }, "已发布为当前线上版本。", "发布被拒绝：可能已有 3 条有效置顶，或线上版本已被其他会话更新。草稿与当前输入已保留；核对置顶或刷新后再试。");
  };

  const withdraw = () => {
    const target = targetRef.current;
    if (!mountedRef.current || busyRef.current || reading || !target.canPublish || !target.versionId) return;
    const pending = { itemId: target.itemId, versionId: target.versionId, expectedRevision: target.expectedRevision };
    withdrawIntentRef.current = pending;
    setWithdrawIntent(pending);
  };

  const confirmWithdraw = () => {
    const pending = withdrawIntentRef.current, target = targetRef.current;
    cancelWithdraw();
    if (!pending || !mountedRef.current || busyRef.current || reading || !target.canPublish || pending.itemId !== target.itemId || pending.versionId !== target.versionId || pending.expectedRevision !== target.expectedRevision) return;
    void run(async () => {
      await adminRequest(`/content/items/${pending.itemId}/withdraw`, { versionId: pending.versionId, expectedRevision: pending.expectedRevision });
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

  const readOnly = !canEdit || !draft || busy || reading;
  const dirty = JSON.stringify(model) !== baseline;
  const requestLeave = (action: "close" | "reload") => {
    if (busyRef.current || reading) return;
    if (dirty) { setLeaveIntent(action); return; }
    if (action === "close") onClose(); else onReload?.();
  };
  const confirmLeave = () => {
    const action = leaveIntent;
    if (!action || busyRef.current || reading) return;
    setLeaveIntent(null);
    if (action === "close") onClose(); else onReload?.();
  };
  return (
    <section className="section-panel content-item-editor" aria-label={item.type === "ANNOUNCEMENT" ? "公告编辑器" : "资讯编辑器"}>
      <div className="content-heading">
        <div className="min-w-0">
          <Button type="button" size="sm" variant="ghost" disabled={busy || reading} onClick={() => requestLeave("close")}><ArrowLeft size={14} aria-hidden="true" />返回列表</Button>
          <h3 className="mt-2 text-lg font-semibold leading-relaxed">{item.type === "ANNOUNCEMENT" ? "公告编辑" : "资讯编辑"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{model.title || "（无标题）"} · {item.gameId === null ? "平台级" : scopeGames.get(item.gameId) ?? item.gameId} · {item.id}</p>
        </div>
        <div className="content-heading-meta">
          {onReload ? <Button type="button" size="sm" variant="ghost" disabled={busy || reading} onClick={() => requestLeave("reload")}>刷新详情</Button> : null}
          <Button type="button" size="sm" variant="secondary" onClick={() => setPreview((value) => !value)}>{preview ? "关闭预览" : "预览用户页面"}</Button>
        </div>
      </div>
      <div className="content-item-facts">
        <Badge variant={stateTone}>{stateLabel}</Badge>
        {published ? <span>线上 v{published.sequence} · 发布 {contentTime(published.publishedAt)}</span> : withdrawnVersion ? <span>线上 v{withdrawnVersion.sequence} 已撤回</span> : <span>尚无线上版本</span>}
        {draft ? <span>草稿 v{draft.sequence} · 更新 {contentTime(draft.updatedAt)}</span> : <span>无草稿</span>}
        {exposureFacts.map(fact => <Badge key={fact.label} variant={fact.tone}>{fact.label}</Badge>)}
      </div>

      <StatusMessage error={error} success={success} className="mt-3" />
      {readOnlyOnline ? <div className="content-readonly-banner"><ShieldAlert size={16} aria-hidden="true" /><div><strong>线上版本只读</strong><p>创建新草稿后才能修改；发布前用户页面继续读取 v{published?.sequence}。当前草稿与线上正文互不影响。</p></div><Button type="button" size="sm" loading={busy} disabled={!canEdit || busy || reading} onClick={createDraft}>编辑已发布内容（新建草稿）</Button></div> : null}
      {readOnlyWithdrawn ? <div className="content-readonly-banner"><ShieldAlert size={16} aria-hidden="true" /><div><strong>线上内容已撤回</strong><p>历史快照只读；从版本历史恢复为草稿后才能重新编辑和发布。</p></div></div> : null}
      {item.type === "NEWS" ? <p className="mt-3 text-xs text-muted-foreground">有时效的资讯；长期指南请用帮助手册。</p> : null}
      <div className="content-editor-actions content-editor-actions-top content-item-actions">
        <div><p className="content-action-state">{dirty ? "有未保存修改" : draft ? "草稿已保存" : "线上内容"}</p><p className={overLimit || diagnostic || promotionDiagnostic ? "content-byte-over" : "text-xs text-muted-foreground"}>{overLimit || (diagnostic || promotionDiagnostic ? "检查未通过" : releaseHint)}</p></div>
        <div>
          {draft ? <Button type="button" size="sm" variant="secondary" loading={busy} disabled={readOnly} onClick={saveDraft}>保存草稿</Button> : null}
          {!draft && source && !readOnlyOnline ? <Button type="button" size="sm" variant="secondary" loading={busy} disabled={!canEdit || busy || reading} onClick={createDraft}>{published ? '编辑已发布内容（新建草稿）' : '恢复内容为新草稿'}</Button> : null}
          {draft && canPublish ? <Button type="button" size="sm" loading={busy} disabled={reading || checking || Boolean(diagnostic || promotionDiagnostic || overLimit) || JSON.stringify(model) !== baseline} onClick={publish}><Send size={14} aria-hidden="true" />发布草稿 v{draft.sequence}</Button> : null}
          {!canEdit ? <span className="text-[11px] text-muted-foreground self-center">只能查看</span> : null}
        </div>
      </div>

      {preview ? (
        <article className="mt-4 rounded border border-border bg-surface-raised p-5 max-w-3xl">
          <h4 className="text-lg font-semibold">{model.title || "（无标题）"}</h4>
          {model.summary ? <p className="text-xs text-muted-foreground mt-2">{model.summary}</p> : null}
          {model.coverMediaId && mediaReadable ? (
            <img src={`/api/bff/admin/content/media/${model.coverMediaId}/content`} alt={model.title || "封面"} className="mt-4 max-h-72 object-contain rounded border border-border" />
          ) : null}
          <div className="mt-4"><Suspense fallback={<p role="status">加载正文预览…</p>}><MarkdownDocument markdown={model.updateSettings.format === 'markdown' ? model.body : plainTextMarkdown(model.body)} mediaUrls={bodyMedia} /></Suspense></div>
          <p className="text-[11px] text-muted-foreground mt-4 border-t border-border pt-3">预览只反映当前编辑内容，不代表已发布。</p>
        </article>
      ) : null}

      <div className="content-section-head"><h4>内容</h4><p>标题、摘要、封面与正文。</p></div>
      {!readOnly && model.updateSettings.format === 'markdown' && !model.body.trim() ? <div className="content-writing-empty"><p>正文还是空的。可以先插入一个基本结构。</p><Button type="button" size="sm" variant="secondary" onClick={() => setModel(current => ({ ...current, body: item.type === 'ANNOUNCEMENT' ? "## 公告内容\n\n- 影响范围：\n- 生效时间：\n- 注意事项：\n" : "## 更新内容\n\n- 新增或调整：\n- 注意事项：\n" }))}>插入示例结构</Button></div> : null}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <label className="space-y-1 text-xs lg:col-span-3">
          <span className="text-muted-foreground">标题（纯文本，UTF-8 ≤200 字节）<span className={titleBytes > 200 ? "content-byte-over" : "content-byte-count"}>{byteLabel(model.title, 200)}</span></span>
          <Input value={model.title} onChange={(event) => setModel((current) => ({ ...current, title: event.target.value }))} className="h-9 text-sm" disabled={readOnly} />
        </label>

        <label className="space-y-1 text-xs lg:col-span-3">
          <span className="text-muted-foreground">摘要（列表展示，UTF-8 ≤500 字节）<span className={summaryBytes > 500 ? "content-byte-over" : "content-byte-count"}>{byteLabel(model.summary, 500)}</span></span>
          <Input value={model.summary} onChange={(event) => setModel((current) => ({ ...current, summary: event.target.value }))} className="h-9 text-sm" disabled={readOnly} />
        </label>
        <div className="space-y-2 text-sm lg:col-span-3"><div className="content-body-head"><p>正文</p><span className="content-body-meta"><span className={bodyBytes > 20000 ? "content-byte-over" : "content-byte-count"}>{byteLabel(model.body, 20000)}</span><Badge variant={checking ? "unknown" : diagnostic ? "destructive" : "success"}>{checking ? "检查中" : diagnostic ? "有发布阻断" : "检查通过"}</Badge></span></div>{model.updateSettings.format === 'markdown' ? <Suspense fallback={<p role="status">加载 Markdown 编辑器…</p>}><MarkdownInput value={model.body} onChange={body => { if (!readOnly) setModel(current => ({ ...current, body })); }} disabled={readOnly || busy} /></Suspense> : <><p className="text-xs text-muted-foreground">原纯文本；转换只改当前草稿。</p><Textarea aria-label="纯文本正文" value={model.body} onChange={e => setModel(current => ({ ...current, body: e.target.value }))} className="min-h-24 text-sm" disabled={readOnly || busy} /><Button type="button" size="sm" variant="secondary" disabled={readOnly || busy} onClick={() => setModel(current => ({ ...current, body: plainTextMarkdown(current.body), updateSettings: { ...current.updateSettings, format: 'markdown' } }))}>转换为 Markdown 后编辑</Button></>}</div>
        {model.updateSettings.format === 'markdown' && mediaReadable ? <div className="space-y-3 lg:col-span-3"><Button type="button" size="sm" variant="secondary" disabled={readOnly || busy} onClick={() => setInsertBodyMedia(x => !x)}>插入正文图片</Button>{insertBodyMedia ? <ContentMediaField label="正文插图" showPreview={false} value={null} disabled={readOnly || busy} hint="选择已审核公开的插图；插入后可在 Markdown 中编辑图片说明。" onSelected={image => setBodyMedia(current => ({ ...current, [image.id]: `/api/v1/content/media/${encodeURIComponent(image.id)}/content` }))} onChange={id => { if (id) setModel(current => ({ ...current, body: `${current.body}\n\n![图片说明](media://${id})\n` })); setInsertBodyMedia(false); }} /> : null}</div> : null}
        <div className="space-y-2 text-xs lg:col-span-3">
          <span className="text-muted-foreground">封面（未审核或撤权素材不能发布）</span>
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

      {diagnostic ? <StatusMessage tone="warning" error={`可保存草稿，处理后才能发布：${diagnostic}`} className="mt-3" /> : null}
      {promotionDiagnostic ? <StatusMessage tone="warning" error={promotionDiagnostic} className="mt-3" /> : null}
      <details className="mt-4 text-xs text-muted-foreground"><summary>旧客户端兼容设置</summary><div className="mt-3 max-w-lg">        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">旧接口排序（平台动态按发布时间及有效置顶排列）</span>
          <div className="flex gap-2">
            <Input value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} className="h-9 text-sm" inputMode="numeric" disabled={!canEdit || busy || reading} />
            <Button type="button" size="sm" variant="secondary" loading={busy} disabled={!canEdit || busy || reading} onClick={saveSort}>保存排序</Button>
          </div>
        </label></div></details>
      <details className="content-detail-secondary">
        <summary>发布与展示设置</summary>
        <ContentUpdateSettings value={model.updateSettings} onChange={value => setModel(current => ({ ...current, updateSettings: value }))} disabled={readOnly || busy} announcement={item.type === 'ANNOUNCEMENT'} />
      </details>
      {/* Save/publish live in the top action bar; withdrawal lives in the version history. */}

      <details className="mt-5">
        <summary className="text-xs text-muted-foreground cursor-pointer select-none">版本历史（{detail.versions.length}）</summary>
        <div className="table-wrap mt-3">
          <table className="data-table">
            <thead><tr><th>版本</th><th>状态</th><th>标题</th><th>修订</th><th>发布时间</th><th>更新时间</th></tr></thead>
            <tbody>
              {detail.versions.map((version) => (
                <tr key={version.id}>
                  <td className="font-mono text-[11px]">v{version.sequence}</td>
                  <td>{version.state === "PUBLISHED" ? "线上" : version.state === "DRAFT" ? "草稿" : version.state === "SUPERSEDED" ? "历史" : "已撤回"}</td>
                  <td>{version.title || "（无标题）"}</td>
                  <td className="font-mono text-[11px]">{version.revision}</td>
                  <td>{version.publishedAt ? contentTime(version.publishedAt) : "-"}</td>
                  <td className="text-[11px] text-muted-foreground">{contentTime(version.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {published && canPublish ? <div className="content-danger-zone"><p>撤回后用户页面不再读取当前线上版本，历史保留。</p><Button type="button" size="sm" variant="danger" loading={busy} onClick={withdraw}>撤回线上版本</Button></div> : null}
      </details>
      <Dialog open={withdrawIntent !== null} onOpenChange={open => { if (!open) cancelWithdraw(); }}>
        <DialogContent showCloseButton={false} role="alertdialog">
          <DialogTitle>确认撤回内容</DialogTitle>
          <DialogDescription>撤回后公共接口立即不可读，历史版本保留。确定撤回？</DialogDescription>
          <DialogFooter>
            <Button type="button" size="sm" variant="secondary" autoFocus onClick={cancelWithdraw}>取消</Button>
            <Button type="button" size="sm" variant="danger" disabled={busy || reading || !canPublish} onClick={confirmWithdraw}>确定撤回</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={leaveIntent !== null} onOpenChange={open => { if (!open) setLeaveIntent(null); }}>
        <DialogContent showCloseButton={false} role="alertdialog">
          <DialogTitle>{leaveIntent === "reload" ? "放弃修改并刷新详情？" : "放弃未保存的修改？"}</DialogTitle>
          <DialogDescription>{leaveIntent === "reload" ? "刷新会读取最新详情并替换当前输入；取消可继续编辑。" : "返回列表会丢弃当前输入；取消可继续编辑。已经发送且结果待核对的请求不会被取消。"}</DialogDescription>
          <DialogFooter>
            <Button type="button" size="sm" variant="secondary" autoFocus onClick={() => setLeaveIntent(null)}>继续编辑</Button>
            <Button type="button" size="sm" variant="danger" disabled={busy || reading} onClick={confirmLeave}>{leaveIntent === "reload" ? "放弃并刷新" : "放弃并返回"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
