import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, FileClock, ImagePlus, PanelLeft, Eye, Columns2, ShieldAlert } from "lucide-react";
import { validateResource, type ContentResource } from "@zzsh/content";
import { inspectMarkdown, convertLegacyDocument } from "@zzsh/content/markdown";
import { MarkdownDocument } from "@zzsh/ui/content-markdown";
import "@zzsh/ui/content-markdown.css";
import { ContentSections } from "@zzsh/ui/content-document";
import { adminRequest, friendlyError } from "../api";
import { Badge } from "../components/ui/badge";
import { Button, StatusMessage } from "../components/ui-elements";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ContentField, ContentMediaField, ContentSelect, ContentText } from "./content-resource-fields";
import { RESOURCE_CATEGORY_LABEL, contentTime, resourcePath, type ContentOperation, type ResourceDetail, type ResourceVersion } from "./content-resources-model";

const MarkdownInput = lazy(() => import("./content-markdown-input"));
type DocumentResource = Extract<ContentResource, { kind: "guide" | "notice" }>;
const compactKeys = new Set(["placement:PUBLISH_SAFE_BOX", "placement:PUBLISH_RESOURCES", "placement:PUBLISH_TERM", "placement:RENTAL_FEES"]);
export type ContentEditorProps = {
  detail: ResourceDetail; canEdit: boolean; canPublish: boolean; locked: boolean; busy?: boolean; operationError?: string; success?: string; pending?: boolean;
  canUpload?: boolean; canReview?: boolean; canBrowseMedia?: boolean; onRecover?: () => void;
  onWrite: (operation: ContentOperation, body: Record<string, unknown>) => Promise<void>;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void; relatedOptions?: { slug: string; title: string }[];
};
export function isMarkdownResource(value: ContentResource): value is Extract<DocumentResource, { format: "markdown" }> {
  return (value.kind === "guide" || value.kind === "notice") && "format" in value && value.format === "markdown";
}

export function ContentResourceEditor(props: ContentEditorProps) {
  const initial = props.detail.draft?.payload ?? props.detail.published?.payload ?? props.detail.baseline ?? props.detail.current.payload ?? props.detail.editorSource?.version.payload;
  if (!initial || (initial.kind !== "guide" && initial.kind !== "notice")) return <StatusMessage error="未能读取文档正文，请返回列表重试。" />;
  return <DocumentEditor {...props} initial={initial} />;
}

function DocumentEditor({ detail, initial, canEdit, canPublish, locked, busy, pending, operationError, success, onRecover, onWrite, onClose, onDirtyChange, canUpload, canReview, canBrowseMedia = false, relatedOptions = [] }: ContentEditorProps & { initial: DocumentResource }) {
  const [model, setModel] = useState<DocumentResource>(initial), [mode, setMode] = useState<"edit" | "split" | "preview">(canEdit ? "split" : "preview");
  const [conversion, setConversion] = useState<Awaited<ReturnType<typeof convertLegacyDocument>> | null>(null), [converting, setConverting] = useState(false);
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof inspectMarkdown>> | null>(null), [checking, setChecking] = useState(false), [checkError, setCheckError] = useState<string>(), [checkNonce, setCheckNonce] = useState(0);
  const [insertMedia, setInsertMedia] = useState(false), [withdraw, setWithdraw] = useState(false), [restore, setRestore] = useState<ResourceVersion | null>(null);
  const [history, setHistory] = useState<{ payload: ContentResource; media: { id: string; url: string | null }[]; version: ResourceVersion } | null>(null), [historyLoading, setHistoryLoading] = useState(false);
  const [media, setMedia] = useState<Record<string, { available: boolean; url: string | null }>>(() => Object.fromEntries((detail.editorSource?.media ?? detail.current.media).map(row => [row.id, { available: Boolean(row.url), url: row.url }])));
  const sequence = useRef(0), historySequence = useRef(0), conversionSequence = useRef(0), editableRef = useRef(canEdit), dirty = JSON.stringify(model) !== JSON.stringify(initial);
  editableRef.current = canEdit;
  const markdown = isMarkdownResource(model) ? model.markdown : null, compact = compactKeys.has(detail.key);
  // 已发布或已撤回的内容必须显式建立新草稿后才能编辑，线上快照保持只读。
  const needsDraft = !detail.draft && (Boolean(detail.published) || detail.current.state === "withdrawn");
  const editable = canEdit && !needsDraft;
  const checkStatus = checking ? "检查正文…" : checkError ? "检查失败" : markdown === null ? "原格式" : !inspection ? "待检查" : inspection.blocking ? `发布阻断 ${inspection.blocking}` : inspection.issues.length ? `提示 ${inspection.issues.length}` : "检查通过";
  const mediaRef = useRef(media); mediaRef.current = media;
  const selectedMedia = useRef<typeof media>({}), qualifiedVersion = useRef<{ stamp: string; media: typeof media } | null>(null);
  const inspectionVersion = detail.draft ?? detail.published;
  const inspectionVersionId = inspectionVersion?.id, inspectionVersionRevision = inspectionVersion?.revision;
  useEffect(() => { onDirtyChange(dirty || locked); }, [dirty, locked, onDirtyChange]);
  useEffect(() => () => { ++sequence.current; ++historySequence.current; ++conversionSequence.current; onDirtyChange(false); }, [onDirtyChange]);
  useEffect(() => { if (!canEdit) { ++conversionSequence.current; setConversion(null); setRestore(null); setConverting(false); } if (!canPublish) setWithdraw(false); }, [canEdit, canPublish]);
  useEffect(() => {
    if (markdown === null) { setInspection(null); setChecking(false); return; }
    const seq = ++sequence.current; setChecking(true); setCheckError(undefined);
    void (async () => {
      try {
        let result = await inspectMarkdown(markdown, { media: mediaRef.current, compact });
        if (result.mediaIds.length && inspectionVersionId) {
          const stamp = `${inspectionVersionId}:${inspectionVersionRevision}:${checkNonce}`;
          if (qualifiedVersion.current?.stamp !== stamp) {
            const version = await adminRequest<{ version: ResourceVersion; media: { id: string; url: string | null }[] }>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(inspectionVersionId)}`);
            if (seq !== sequence.current) return;
            if (version.version.id !== inspectionVersionId || version.version.revision !== inspectionVersionRevision || !Array.isArray(version.media)) throw new Error("内容版本已变化，请重新读取内容后再发布。");
            qualifiedVersion.current = { stamp, media: Object.fromEntries(version.media.map(row => [row.id, { available: typeof row.url === "string" && Boolean(row.url), url: row.url }])) };
          }
          const next = { ...Object.fromEntries(detail.current.media.map(row => [row.id, { available: Boolean(row.url), url: row.url }])), ...selectedMedia.current, ...qualifiedVersion.current.media };
          mediaRef.current = next; setMedia(next);
          result = await inspectMarkdown(markdown, { media: next, compact });
        }
        if (seq === sequence.current) setInspection(result);
      } catch (failure) { if (seq === sequence.current) setCheckError(friendlyError(failure)); }
      finally { if (seq === sequence.current) setChecking(false); }
    })();
    return () => { ++sequence.current; };
  }, [markdown, compact, checkNonce, inspectionVersionId, inspectionVersionRevision, detail.key]);
  const patch = (fields: Record<string, unknown>) => { if (!locked && editable) setModel(current => ({ ...current, ...fields }) as DocumentResource); };
  let invalid: string | undefined;
  try { validateResource(detail.key, model); } catch (failure) { invalid = failure instanceof Error ? failure.message : "请检查文档内容。"; }
  const beginConversion = async () => {
    if (converting || locked || !editable || !model.sections) return;
    const seq = ++conversionSequence.current;
    setConverting(true); setCheckError(undefined);
    try { const converted = await convertLegacyDocument({ sections: model.sections }); if (seq === conversionSequence.current && editableRef.current) setConversion(converted); }
    catch (failure) { if (seq === conversionSequence.current) setCheckError(friendlyError(failure)); }
    finally { if (seq === conversionSequence.current) setConverting(false); }
  };
  const adoptConversion = () => {
    if (!conversion?.lossless || locked || !editable) return;
    const { sections: _sections, ...rest } = model as DocumentResource & { sections?: unknown };
    setModel({ ...rest, format: "markdown", schemaVersion: 1, markdown: conversion.markdown, anchorAliases: conversion.anchorAliases, mediaIds: [] } as DocumentResource);
    setConversion(null);
  };
  const readHistory = async (version: ResourceVersion) => {
    const seq = ++historySequence.current; setHistoryLoading(true); setCheckError(undefined);
    try {
      const result = await adminRequest<{ version: ResourceVersion; media: { id: string; url: string | null }[] }>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(version.id)}`);
      if (seq === historySequence.current && result.version.payload) setHistory({ version: result.version, payload: result.version.payload, media: result.media });
    } catch (failure) { if (seq === historySequence.current) setCheckError(friendlyError(failure)); }
    finally { if (seq === historySequence.current) setHistoryLoading(false); }
  };
  const save = () => { if (editable && !locked && !invalid && dirty) void onWrite("content.resource.draft.save", { payload: validateResource(detail.key, model) }); };
  const urls = Object.fromEntries(Object.entries(media).map(([id, row]) => [id, row.available ? row.url : null]));
  const canRelease = canPublish && Boolean(detail.draft) && !dirty && !locked && !invalid && !checking && !checkError && (markdown === null || inspection?.blocking === 0);
  const releaseReason = !canPublish ? canEdit ? "当前账号没有发布权限；可保存草稿交有发布权限的管理员处理。" : "当前账号只能查看，不能保存或发布。"
    : needsDraft ? "线上版本只读；先创建草稿并保存，再发布。"
    : !detail.draft ? "没有待发布草稿；先保存草稿。"
    : dirty ? "有未保存修改，先保存草稿再发布。"
    : checking ? "正在检查正文与媒体资格…"
    : checkError ? "正文检查失败，请重新检查。"
    : invalid ? invalid
    : inspection?.blocking ? `正文有 ${inspection.blocking} 处发布阻断，处理后才能发布。`
    : markdown === null && detail.draft ? "当前仍为原格式，发布沿用原格式快照；如需 Markdown 请先转换。"
    : "发布后用户页面立即读取这一版本；旧版本保留为历史。";
  return <section className="section-panel content-document-editor space-y-5" aria-label="内容编辑器">
    <div className="content-heading content-editor-head"><div className="min-w-0"><Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />返回文档列表</Button><div className="content-title-row"><h3>{model.title || "未命名文档"}</h3><Badge variant={checkError || inspection?.blocking ? "destructive" : checking || !inspection ? "unknown" : "success"}>{checkStatus}</Badge></div><p className="content-item-sub">{detail.definition?.locations.join(" · ") || "帮助中心"} · {model.kind === "guide" ? "帮助手册" : "流程说明"}</p><div className="content-item-facts"><Badge variant={detail.published ? "success" : detail.current.state === "withdrawn" ? "warning" : "info"}>{detail.published ? `线上 v${detail.published.sequence}` : detail.current.state === "withdrawn" ? "已撤回" : detail.current.source === "BUILTIN" ? "内置内容" : "未发布"}</Badge>{detail.draft ? <Badge variant="info">草稿 v{detail.draft.sequence}</Badge> : null}<span className="content-key">{detail.key}</span></div></div></div>
    {needsDraft ? <div className="content-readonly-banner"><ShieldAlert size={16} aria-hidden="true" /><div><strong>{detail.current.state === "withdrawn" ? "线上内容已撤回" : "线上版本只读"}</strong><p>{detail.current.state === "withdrawn" ? "历史快照只读；创建新草稿或从版本历史恢复后才能继续编辑。" : "先创建草稿；发布前用户页面继续读取当前线上版本。"}</p></div>{canEdit ? <Button type="button" size="sm" disabled={locked} onClick={() => void onWrite("content.resource.draft.create", {})}>创建草稿后编辑</Button> : null}</div> : null}
    {!canEdit ? <StatusMessage tone="warning" error={canPublish ? "当前账号不能编辑或保存；可按发布权限处理已有草稿。" : "当前账号只能查看，不能保存或发布。"} /> : null}
    {operationError || checkError ? <div className="space-y-2"><StatusMessage error={operationError || checkError} />{(checkError || operationError) && markdown !== null ? <Button type="button" size="sm" variant="secondary" disabled={checking} onClick={() => setCheckNonce(value => value + 1)}>重新检查正文</Button> : null}</div> : null}
    {pending && !busy ? <StatusMessage tone="warning" error="上次操作结果待核对；原请求已保留。" /> : null}
    <div className="content-editor-actions content-editor-actions-top"><div><p className="content-action-state">{dirty ? "有未保存修改" : detail.draft ? "草稿已保存" : "线上内容"}</p><p className={canRelease ? "content-save-success" : "text-xs text-muted-foreground"}>{success || (canPublish && !canRelease ? releaseReason : "")}</p></div><div>{pending && !busy && onRecover ? <Button type="button" variant="secondary" loading={busy} onClick={onRecover}>核对原操作结果</Button> : null}{editable ? <Button type="button" variant="secondary" disabled={locked || !dirty || Boolean(invalid)} onClick={save}>保存草稿</Button> : null}{canPublish ? <Button type="button" disabled={!canRelease} onClick={() => void onWrite("content.resource.publish", { versionId: detail.draft!.id, expectedRevision: detail.item!.revision })}>{busy ? "处理中…" : "发布到用户页面"}</Button> : null}</div></div>
    <fieldset disabled={!editable || locked} className="space-y-4">
      <div className="content-document-meta"><ContentText label="文档标题" value={model.title} onChange={title => patch({ title })} />{model.kind === "guide" ? <ContentField label="所属分类"><ContentSelect ariaLabel="所属分类" value={model.category} onChange={category => patch({ category })} options={Object.entries(RESOURCE_CATEGORY_LABEL).map(([value, label]) => ({ value, label }))} /></ContentField> : <p className="self-end text-sm text-muted-foreground">{detail.definition?.locations.join(" · ")}</p>}</div>
      {model.kind === "guide" ? <ContentText label="摘要" value={model.summary} onChange={summary => patch({ summary })} max={500} multiline /> : null}
    </fieldset>
    {markdown === null ? <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-4"><div><p className="font-medium text-sm">原格式文档</p><p className="mt-1 text-sm text-muted-foreground">当前内容按原格式完整显示。编辑正文前先转换，历史版本保持原样。</p></div>{canEdit ? <Button type="button" variant="secondary" disabled={locked || converting} onClick={() => void beginConversion()}>{converting ? "检查转换内容…" : "转换为 Markdown 后编辑"}</Button> : null}</div><div className="content-editor-pane content-editor-preview">{model.sections ? <ContentSections sections={model.sections} mediaUrls={urls} /> : <StatusMessage error="原格式正文缺失，请重新读取内容。" />}</div></div> : <>
      <div className="content-section-head"><h4>正文</h4><p>Markdown · 与用户页同版式</p></div>
      {editable && markdown !== null && !markdown.trim() ? <div className="content-writing-empty"><p>正文还是空的。可以先插入一个基本结构。</p><Button type="button" size="sm" variant="secondary" onClick={() => patch({ markdown: "## 说明\n\n在这里填写帮助内容。\n\n- 适用情况：\n- 操作步骤：\n- 注意事项：\n" })}>插入示例结构</Button></div> : null}
      <div className="content-editor-modes"><div className="flex gap-1" role="group" aria-label="正文工作模式">{([['edit', '编辑', PanelLeft], ['split', '分屏', Columns2], ['preview', '预览', Eye]] as const).map(([value, label, Icon]) => <Button key={value} type="button" size="sm" variant={mode === value ? "primary" : "secondary"} aria-pressed={mode === value} onClick={() => setMode(value)}><Icon size={14} aria-hidden="true" />{label}</Button>)}</div><div className="flex items-center gap-3">{editable && canBrowseMedia ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setInsertMedia(!insertMedia)}><ImagePlus size={14} aria-hidden="true" />插入图片</Button> : null}</div></div>
      {insertMedia && canBrowseMedia ? <ContentMediaField label="选择文章插图" value={null} onChange={id => { if (id) patch({ markdown: `${markdown}\n\n![图片说明](media://${id})\n` }); setInsertMedia(false); }} onSelected={option => { const chosen = { available: true, url: `/api/bff/admin/content/media/${encodeURIComponent(option.id)}/content` }; selectedMedia.current[option.id] = chosen; const next = { ...mediaRef.current, [option.id]: chosen }; mediaRef.current = next; setMedia(next); }} hint="插入后请在正文中填写图片说明。仅可使用审核通过并公开的素材。" disabled={!editable || locked} canUpload={canUpload} canReview={canReview} /> : null}
      <div className="content-editor-panes" data-mode={mode}>{mode !== "preview" ? <div className="content-editor-pane"><div className="content-editor-pane-heading">正文编辑</div><Suspense fallback={<div className="p-6 text-sm text-muted-foreground" role="status">加载编辑器…</div>}><MarkdownInput value={markdown} onChange={source => patch({ markdown: source })} disabled={!editable || locked} /></Suspense></div> : null}{mode !== "edit" ? <div className="content-editor-pane"><div className="content-editor-pane-heading">用户页面正文预览</div><div className="content-editor-preview"><article><h1 className="mb-4 text-xl font-semibold leading-relaxed">{model.title}</h1><MarkdownDocument markdown={markdown} mediaUrls={urls} compact={compact} /></article></div></div> : null}</div>
      {inspection?.issues.length ? <div className="space-y-2 rounded-lg border border-warning/40 p-4" role="status"><p className="font-medium text-sm">{inspection.blocking ? "可保存原稿，处理以下内容后才能发布" : "发布前提示"}</p><ul className="space-y-2 text-sm">{inspection.issues.map((issue, index) => <li key={`${issue.code}:${index}`}><span className="font-medium">第 {issue.line} 行：{issue.message}</span>{issue.hint ? <p className="mt-1 text-muted-foreground">{issue.hint}</p> : null}</li>)}</ul></div> : null}
    </>}
    {invalid ? <StatusMessage error={invalid} /> : null}
    {/* Primary save/publish actions are in the top action bar so they stay discoverable. */}
    <details className="content-detail-secondary"><summary>文档设置</summary>{model.kind === "guide" ? <fieldset disabled={!editable || locked} className="mt-4 space-y-4"><div className="flex flex-wrap gap-4 text-sm">{(["all", "renter", "owner"] as const).map((value, index) => <label key={value} className="flex items-center gap-2"><Checkbox disabled={!editable || locked} id={`audience-${value}`} checked={model.audience.includes(value)} onCheckedChange={checked => patch({ audience: checked === true ? [...model.audience, value] : model.audience.filter(item => item !== value) })} />{["所有用户", "租客", "号主"][index]}</label>)}</div><ContentText label="搜索关键词（每行一项）" multiline value={model.keywords.join("\n")} max={2000} onChange={value => patch({ keywords: value ? value.split("\n") : [] })} /><ContentField label="相关说明"><div className="content-related-list">{relatedOptions.filter(option => option.slug !== model.slug).map(option => <label key={option.slug} className="content-check"><Checkbox disabled={!editable || locked} id={`related-${option.slug}`} checked={model.related.includes(option.slug)} onCheckedChange={checked => patch({ related: checked === true ? [...model.related, option.slug] : model.related.filter(item => item !== option.slug) })} />{option.title}</label>)}{!relatedOptions.some(option => option.slug !== model.slug) ? <span className="text-xs text-muted-foreground">暂无可关联的说明。</span> : null}</div></ContentField><label className="flex items-center gap-2 text-sm"><Checkbox disabled={!editable || locked} id="guide-contact-cta" checked={model.contactCta ?? false} onCheckedChange={checked => patch({ contactCta: checked === true })} />显示联系客服入口</label></fieldset> : <p className="mt-3 text-sm text-muted-foreground">这段说明用于固定业务位置；报价、资格和订单条款仍由对应业务模块维护。</p>}</details>
    <details className="content-detail-secondary"><summary>版本历史</summary><div className="mt-4 space-y-4"><p className="text-xs text-muted-foreground break-all">{detail.key} · 并发版本 {detail.item?.revision ?? "未创建"}</p>{historyLoading ? <p className="text-sm" role="status">读取历史版本…</p> : null}<div className="table-wrap"><table className="data-table"><thead><tr><th>版本</th><th>状态</th><th>发布 / 更新时间</th><th>操作</th></tr></thead><tbody>{detail.versions.map(version => <tr key={version.id}><td>v{version.sequence}</td><td>{{ PUBLISHED: "线上", DRAFT: "草稿", SUPERSEDED: "历史", WITHDRAWN: "已撤回" }[version.state] ?? version.state}</td><td className="text-[11px]"><span className="block">{version.publishedAt ? `发布 ${contentTime(version.publishedAt)}` : "未发布"}</span><span className="block text-muted-foreground">更新 {contentTime(version.updatedAt)}</span></td><td><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={historyLoading} onClick={() => void readHistory(version)}>查看原版本</Button>{version.state !== "DRAFT" && canEdit ? <Button type="button" size="sm" variant="secondary" disabled={locked} onClick={() => setRestore(version)}><FileClock size={13} aria-hidden="true" />恢复为草稿</Button> : null}</div></td></tr>)}</tbody></table></div>{detail.published && canPublish ? <Button type="button" size="sm" variant="danger" disabled={locked || dirty} onClick={() => setWithdraw(true)}>撤回线上版本</Button> : null}</div></details>
    <Dialog open={Boolean(conversion)} onOpenChange={open => { if (!open) setConversion(null); }}><DialogContent className="max-w-3xl"><DialogTitle>检查 Markdown 转换结果</DialogTitle><DialogDescription>仅创建当前工作副本，不修改原历史。确认后还需保存草稿并发布。</DialogDescription>{conversion?.issues.length ? <StatusMessage error={conversion.issues.join("；")} /> : <p className="text-sm text-muted-foreground">文字和结构已按支持的格式转换，原章节地址保留兼容映射。</p>}<div className="max-h-80 overflow-auto rounded-lg border border-border p-4"><MarkdownDocument markdown={conversion?.markdown ?? ""} mediaUrls={urls} /></div><DialogFooter><Button type="button" variant="secondary" onClick={() => setConversion(null)}>保留原格式</Button><Button type="button" disabled={!conversion?.lossless || locked} onClick={adoptConversion}>确认转换并编辑</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(history)} onOpenChange={open => { if (!open) setHistory(null); }}><DialogContent className="max-w-3xl"><DialogTitle>历史版本 v{history?.version.sequence}</DialogTitle><DialogDescription>按此版本原有格式读取。这里只预览，不更改线上版本。</DialogDescription><div className="max-h-[65vh] overflow-auto p-2">{history && (isMarkdownResource(history.payload) ? <MarkdownDocument markdown={history.payload.markdown} mediaUrls={Object.fromEntries(history.media.map(row => [row.id, row.url]))} /> : history.payload.kind === "guide" || history.payload.kind === "notice" ? <ContentSections sections={history.payload.sections} mediaUrls={Object.fromEntries(history.media.map(row => [row.id, row.url]))} /> : <p>此版本不是文档。</p>)}</div></DialogContent></Dialog>
    <Dialog open={Boolean(restore)} onOpenChange={open => { if (!open) setRestore(null); }}><DialogContent role="alertdialog"><DialogTitle>将 v{restore?.sequence} 恢复为新草稿？</DialogTitle><DialogDescription>{detail.draft || dirty ? "当前工作副本会被替换，已有草稿保留为历史记录。" : "将复制此版本的正文、元数据和媒体引用。"}原格式保持不变，保存或恢复草稿不会改变线上内容。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setRestore(null)}>取消</Button><Button type="button" disabled={locked} onClick={() => { const value = restore; setRestore(null); if (value) void onWrite("content.resource.draft.restore", { sourceVersionId: value.id, expectedRevision: detail.item!.revision }); }}>恢复为新草稿</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={withdraw} onOpenChange={setWithdraw}><DialogContent role="alertdialog"><DialogTitle>撤回当前线上内容？</DialogTitle><DialogDescription>用户侧将不再读取此版本；历史保留，恢复后需重新发布。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setWithdraw(false)}>取消</Button><Button type="button" variant="danger" disabled={locked} onClick={() => { setWithdraw(false); void onWrite("content.resource.withdraw", { versionId: detail.published!.id, expectedRevision: detail.item!.revision }); }}>确认撤回</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
