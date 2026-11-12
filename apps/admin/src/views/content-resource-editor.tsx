import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileClock, MoreHorizontal, Search, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { canonicalize, extractPlate, validatePlateDocument, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { adminRequest, friendlyError } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingStatusMessage, StatusMessage } from "../components/ui-elements";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import { ContentField, ContentMediaField, ContentSelect, ContentText } from "./content-resource-fields";
import { ContentKeywordChips } from "./content-keyword-chips";
import { RESOURCE_CATEGORY_LABEL, contentTime, resourcePath, type ContentOperation, type ResourceDetail, type ResourceVersion } from "./content-resources-model";
import { adminMediaUrl, buildPlatePayload, readPlateDocument, resourcePreset, ContentSaveStatus, type ContentSavePhase, type PlateSeed } from "./content-plate";
import type { ContentResource } from "@zzsh/content";
import type { PlateEditorHandle } from "../components/plate/plate-editor";

const PlateEditor = lazy(() => import("../components/plate/plate-editor"));

type DocumentResource = Extract<ContentResource, { kind: "guide" | "notice" }>;
export type ContentEditorProps = {
  detail: ResourceDetail; canEdit: boolean; canPublish: boolean; locked: boolean; busy?: boolean; operationError?: string; success?: string; pending?: boolean;
  canUpload?: boolean; canReview?: boolean; canBrowseMedia?: boolean; onRecover?: () => void;
  /** 写入 hook 检测到 409：停止自动保存，横幅提示，编辑器只读但本地内容保留。 */
  conflict?: boolean; onReload?: () => void;
  onWrite: (operation: ContentOperation, body: Record<string, unknown>) => Promise<ResourceDetail | void>;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void; relatedOptions?: { slug: string; title: string }[];
  hideBackButton?: boolean;
  autosaveDelayMs?: number;
  helpDirectoryLabel?: string;
  publicUrl?: string;
  onPublishProgress?: (busy: boolean) => void;
  onEditorMount?: (key: string, editor: PlateEditorHandle) => void;
  pendingPublish?: boolean;
  canViewHistory?: boolean;
};

/** 工作副本：元数据照搬 payload，正文只读 plate document（不读取、不转换旧格式）。 */
type ResourceModel = {
  title: string;
  summary: string;
  category: string;
  audience: ("renter" | "owner" | "all")[];
  keywords: string[];
  related: string[];
  contactCta: boolean;
  document: PlateDocumentEnvelope;
  anchorAliases: Record<string, string>;
};

function readModel(payload: DocumentResource): ResourceModel {
  const kind = payload.kind;
  const { document, anchorAliases } = readPlateDocument(payload, resourcePreset(kind));
  const guide = kind === "guide" ? payload as Extract<DocumentResource, { kind: "guide" }> : null;
  return {
    title: payload.title ?? "",
    summary: guide?.summary ?? "",
    category: guide?.category ?? "rental",
    audience: guide ? [...guide.audience] : ["all"],
    keywords: guide ? [...guide.keywords] : [],
    related: guide ? [...guide.related] : [],
    contactCta: guide?.contactCta ?? false,
    document,
    anchorAliases,
  };
}

export function ContentResourceEditor(props: ContentEditorProps) {
  const initial = props.detail.draft?.payload ?? props.detail.published?.payload ?? props.detail.baseline ?? props.detail.current.payload ?? props.detail.editorSource?.version.payload;
  if (!initial || (initial.kind !== "guide" && initial.kind !== "notice")) return <StatusMessage error="未能读取文档正文，请返回列表重试。" />;
  return <DocumentEditor {...props} initial={initial} />;
}

function DocumentEditor({ detail, initial, canEdit, canPublish, locked, busy, pending, pendingPublish, operationError, success, onRecover, conflict = false, onReload, onWrite, onClose, onDirtyChange, canUpload, canReview, canBrowseMedia = false, relatedOptions = [], autosaveDelayMs = 2000, helpDirectoryLabel, publicUrl, onPublishProgress, onEditorMount, canViewHistory = true, hideBackButton = false }: ContentEditorProps & { initial: DocumentResource }) {
  const kind = initial.kind;
  const preset = resourcePreset(kind);
  const inHelpWorkspace = helpDirectoryLabel !== undefined;
  const [preview, setPreview] = useState(false);
  const editorPage = useRef<HTMLDivElement>(null), lastFocused = useRef<HTMLElement | null>(null), selection = useRef<Range | null>(null);
  const scrollPositions = useRef<{ element: Element; top: number; left: number }[]>([]), wasPreview = useRef(false), live = useRef(true);
  const [model, setModel] = useState<ResourceModel>(() => readModel(initial));
  const modelRef = useRef(model); modelRef.current = model;
  const editorRef = useRef<PlateEditorHandle>(null), insertBlock = useRef<string | undefined>(undefined);
  const attachEditor = useCallback((editor: PlateEditorHandle | null) => {
    editorRef.current = editor;
    if (editor && onEditorMount) requestAnimationFrame(() => {
      if (editorRef.current === editor) onEditorMount(detail.key, editor);
    });
  }, [detail.key, onEditorMount]);
  // 语义比较（键序无关）：Plate 挂载规范化会重排键序，JSON 直比会产生幻影脏态并触发多余自动保存。
  // onChange 已在 PlateEditor 内经 toPlateEnvelope 白名单化，这里只做 canonical 比较。
  const [baseline, setBaseline] = useState(() => canonicalize(readModel(initial)));
  const [inspection, setInspection] = useState<{ blocking: number; issues: { code: string; message: string; mediaId?: string }[] } | null>(null);
  const [checking, setChecking] = useState(false), [checkError, setCheckError] = useState<string>(), [checkNonce, setCheckNonce] = useState(0);
  const [insertMedia, setInsertMedia] = useState(false), [withdraw, setWithdraw] = useState(false), [restore, setRestore] = useState<ResourceVersion | null>(null), [discard, setDiscard] = useState(false);
  const [history, setHistory] = useState<{ payload: ContentResource; media: { id: string; url: string | null }[]; version: ResourceVersion } | null>(null), [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [historySelection, setHistorySelection] = useState<string>();
  const [relatedQuery, setRelatedQuery] = useState("");
  const [versionTransition, setVersionTransition] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [issuesOpen, setIssuesOpen] = useState(false);
  const [releaseError, setReleaseError] = useState<string>(), [releaseBusy, setReleaseBusy] = useState(false), [publishingRequest, setPublishingRequest] = useState(false), [insertError, setInsertError] = useState<string>();
  const [releaseMediaIds, setReleaseMediaIds] = useState<string[]>([]);
  const releaseLock = useRef(false);
  const [media, setMedia] = useState<Record<string, { available: boolean; url: string | null }>>(() => Object.fromEntries((detail.editorSource?.media ?? detail.current.media).map(row => [row.id, { available: Boolean(row.url), url: row.url }])));
  const sequence = useRef(0), historySequence = useRef(0);
  const dirty = canonicalize(model) !== baseline;
  // 已发布或已撤回的内容必须显式建立新草稿后才能编辑，线上快照保持只读。
  const needsDraft = !detail.draft && (inHelpWorkspace || Boolean(detail.published) || detail.current.state === "withdrawn");
  const editable = canEdit && !needsDraft;
  const mediaRef = useRef(media); mediaRef.current = media;
  const selectedMedia = useRef<typeof media>({}), qualifiedVersion = useRef<{ stamp: string; media: typeof media } | null>(null);
  const inspectionVersion = detail.draft ?? detail.published;
  const inspectionVersionId = inspectionVersion?.id, inspectionVersionRevision = inspectionVersion?.revision;
  const projection = useMemo(() => extractPlate(model.document), [model.document]);
  const mediaIds = projection.mediaIds;
  const mediaKey = mediaIds.join(",");
  useEffect(() => { onDirtyChange(dirty || (!inHelpWorkspace && locked)); }, [dirty, inHelpWorkspace, locked, onDirtyChange]);
  useEffect(() => { live.current = true; return () => { live.current = false; onPublishProgress?.(false); }; }, [onPublishProgress]);
  useEffect(() => () => { ++sequence.current; ++historySequence.current; onDirtyChange(false); }, [onDirtyChange]);
  useEffect(() => { if (!canEdit) setRestore(null); if (!canPublish) setWithdraw(false); }, [canEdit, canPublish]);

  // 媒体资格：正文引用的素材必须审核通过且公开；以版本媒体清单为准，失败可重试。
  useEffect(() => {
    if (!mediaIds.length || (!canEdit && !canPublish)) { setInspection(null); setChecking(false); setCheckError(undefined); return; }
    const seq = ++sequence.current; setChecking(true); setCheckError(undefined);
    void (async () => {
      try {
        let next = mediaRef.current;
        if (inspectionVersionId) {
          const stamp = `${inspectionVersionId}:${inspectionVersionRevision}:${checkNonce}`;
          if (qualifiedVersion.current?.stamp !== stamp) {
            const version = await adminRequest<{ version: ResourceVersion; media: { id: string; url: string | null }[] }>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(inspectionVersionId)}`);
            if (seq !== sequence.current) return;
            if (version.version.id !== inspectionVersionId || version.version.revision !== inspectionVersionRevision || !Array.isArray(version.media)) throw new Error("内容版本已变化，请重新读取内容后再发布。");
            qualifiedVersion.current = { stamp, media: Object.fromEntries(version.media.map(row => [row.id, { available: typeof row.url === "string" && Boolean(row.url), url: row.url }])) };
          }
          next = { ...Object.fromEntries(detail.current.media.map(row => [row.id, { available: Boolean(row.url), url: row.url }])), ...selectedMedia.current, ...qualifiedVersion.current.media };
          mediaRef.current = next; setMedia(next);
        }
        if (seq !== sequence.current) return;
        const unavailable = mediaIds.filter(id => !next[id]?.available);
        setInspection({ blocking: unavailable.length, issues: unavailable.map(id => ({ code: "MEDIA_NOT_ALLOWED", mediaId: id, message: `素材 ${id} 不可用：未审核公开、已撤权或读取失败。` })) });
      } catch (failure) { if (seq === sequence.current) setCheckError(friendlyError(failure)); }
      finally { if (seq === sequence.current) setChecking(false); }
    })();
    return () => { ++sequence.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey, checkNonce, inspectionVersionId, inspectionVersionRevision, detail.key, canEdit, canPublish]);

  const patch = (fields: Partial<ResourceModel>) => { if (!readOnly) { modelRef.current = { ...modelRef.current, ...fields }; setModel(modelRef.current); } };
  const draftCheck = validatePlateDocument(model.document, { preset, mode: "draft" });
  const publishCheck = validatePlateDocument(model.document, { preset, mode: "publish" });
  const invalid = !draftCheck.ok ? draftCheck.errors.slice(0, 5).map(issue => `${issue.path}：${issue.message}`).join("；") : kind === "guide" && !model.title.trim() ? "文档标题不能为空。" : undefined;
  const checkStatus = checking ? "检查媒体资格…" : checkError ? "检查失败" : !mediaIds.length ? "无正文图片" : inspection?.blocking ? `发布阻断 ${inspection.blocking}` : "检查通过";

  // 保存只更新基线与状态字：记录发送时的语义快照，写入成功后就地推进基线，
  // 不重挂载编辑器（父层对 draft.save 不再 bump editorGeneration）。
  const pendingSave = useRef<string | null>(null);
  const save = () => {
    if (editable && !locked && !invalid && !conflict && dirty) {
      pendingSave.current = canonicalize(model);
      void onWrite("content.resource.draft.save", { payload: savePayload() });
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  // 自动保存草稿：停顿 2 秒；已发布版本不可变（needsDraft 时只读，需显式建草稿）。
  useEffect(() => {
    if (!dirty || !editable || locked || releaseBusy || conflict || invalid || (inHelpWorkspace && operationError)) return;
    const timer = setTimeout(() => { saveRef.current(); }, autosaveDelayMs);
    return () => clearTimeout(timer);
  }, [dirty, editable, locked, releaseBusy, conflict, invalid, inHelpWorkspace, operationError, model, autosaveDelayMs]);

  // 写入结束（busy true→false）且无冲突/错误时，把基线推进到已保存快照；失败则保留脏态可重试。
  const prevBusy = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusy.current;
    prevBusy.current = busy;
    if (wasBusy && !busy && pendingSave.current !== null) {
      if (inHelpWorkspace && pending && operationError) return;
      const snapshot = pendingSave.current;
      pendingSave.current = null;
      if (!conflict && !operationError) setBaseline(snapshot);
    }
  }, [busy, conflict, inHelpWorkspace, operationError, pending]);

  const savePayload = (): Record<string, unknown> => {
    const model = modelRef.current;
    const identity = initial as DocumentResource & { id?: string; slug?: string; game?: string; updatedAt?: string };
    const guideMeta = kind === "guide" ? {
      summary: model.summary, category: model.category, audience: model.audience, keywords: model.keywords, related: model.related, contactCta: model.contactCta,
      ...(identity.id !== undefined ? { id: identity.id } : {}), ...(identity.slug !== undefined ? { slug: identity.slug } : {}),
      ...(identity.game !== undefined ? { game: identity.game } : {}), ...(identity.updatedAt !== undefined ? { updatedAt: identity.updatedAt } : {}),
    } : {};
    return { kind, title: model.title, ...guideMeta, ...buildPlatePayload(model.document, model.anchorAliases) };
  };

  const readHistory = async (version: ResourceVersion) => {
    const seq = ++historySequence.current;
    setHistorySelection(version.id); setHistory(null); setHistoryLoading(true); setHistoryError(undefined);
    try {
      const result = await adminRequest<{ version: ResourceVersion; media: { id: string; url: string | null }[] }>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(version.id)}`);
      if (!result.version.payload) throw new Error("这个版本没有可预览的正文。");
      if (seq === historySequence.current) setHistory({ version: result.version, payload: result.version.payload, media: result.media });
    } catch (failure) { if (seq === historySequence.current) setHistoryError(friendlyError(failure)); }
    finally { if (seq === historySequence.current) setHistoryLoading(false); }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    const first = detail.published ?? detail.versions[0];
    if (first) void readHistory(first);
  };

  const urls: Record<string, string> = {};
  for (const [id, row] of Object.entries(media)) if (row.available && row.url) urls[id] = row.url;
  const canRelease = canPublish && Boolean(detail.draft) && (inHelpWorkspace || !dirty) && !locked && !releaseBusy && !conflict && !invalid && !checking && !checkError && publishCheck.ok && (inspection?.blocking ?? 0) === 0;
  const releaseReason = !canPublish ? canEdit ? "当前账号没有发布权限；可保存草稿交有发布权限的管理员处理。" : "当前账号只能查看，不能保存或发布。"
    : needsDraft ? "线上版本只读；先创建草稿并保存，再发布。"
    : !detail.draft ? "没有待发布草稿；先保存草稿。"
    : dirty && !inHelpWorkspace ? "有未保存修改，先保存草稿再发布。"
    : checking ? "正在检查正文与媒体资格…"
    : checkError ? "正文检查失败，请重新检查。"
    : invalid ? invalid
    : !publishCheck.ok ? `发布校验未通过：${publishCheck.errors.slice(0, 3).map(issue => `${issue.path} ${issue.message}`).join("；")}`
    : inspection?.blocking ? `正文有 ${inspection.blocking} 处发布阻断，处理后才能发布。`
    : "发布后用户页面立即读取这一版本；旧版本保留为历史。";

  // PlateEditor 挂载时注入值；readOnly 切换以最新本地值重挂载，冲突时保留本地内容可复制。
  const readOnly = !editable || (!inHelpWorkspace && locked) || conflict || publishingRequest || Boolean(pendingPublish) || versionTransition;
  // 编辑器只读态必须与“保存中”解耦：PlateEditor 内部 usePlateEditor 依赖 [preset, readOnly]，
  // 若把 transient locked/busy 计入 readOnly，每次保存都会重建 contenteditable → 整页闪烁。
  // editorReadOnly 只反映持久状态（无草稿/冲突），保存期间保持不变，编辑器 DOM 节点身份不变。
  const editorReadOnly = !editable || conflict;
  const [seed, setSeed] = useState<PlateSeed>(() => ({ key: 0, value: model.document.value }));
  const localValue = useRef<PlateNode[]>(seed.value);
  const prevReadOnly = useRef(editorReadOnly);
  useEffect(() => {
    if (prevReadOnly.current !== editorReadOnly) {
      prevReadOnly.current = editorReadOnly;
      setSeed(current => ({ key: current.key + 1, value: localValue.current }));
    }
  }, [editorReadOnly]);
  const onEditorChange = (envelope: PlateDocumentEnvelope) => {
    localValue.current = envelope.value;
    modelRef.current = { ...modelRef.current, document: envelope };
    setModel(modelRef.current);
  };
  const closeImagePicker = (focusId = insertBlock.current) => {
    setInsertMedia(false); setInsertError(undefined); insertBlock.current = undefined;
    if (focusId) requestAnimationFrame(() => editorRef.current?.focusBlock(focusId));
  };
  const openImagePicker = (blockId: string) => {
    if (readOnly || !editorRef.current?.hasBlock(blockId)) return;
    insertBlock.current = blockId;
    setInsertError(undefined); setInsertMedia(true);
  };
  const insertImage = (mediaId: string) => {
    if (readOnly || !insertBlock.current) return;
    const imageBlock = editorRef.current?.insertImagesAfter(insertBlock.current, [{ mediaId, alt: "图片说明" }]);
    if (!imageBlock) { setInsertError("插入位置已变化，请回到正文重新选择位置。"); return; }
    const chosen = { available: true, url: adminMediaUrl(mediaId) };
    selectedMedia.current[mediaId] = chosen;
    const merged = { ...mediaRef.current, [mediaId]: chosen };
    mediaRef.current = merged; setMedia(merged);
    closeImagePicker(imageBlock);
  };

  const publishHelp = async () => {
    if (!canRelease || releaseLock.current || !detail.draft || !detail.item) return;
    releaseLock.current = true; setReleaseBusy(true); onPublishProgress?.(true); setReleaseError(undefined); setReleaseMediaIds([]);
    const snapshot = canonicalize(modelRef.current), originalDraftId = detail.draft.id;
    try {
      let saved = detail;
      if (canEdit) {
        pendingSave.current = snapshot;
        const receipt = await onWrite("content.resource.draft.save", { payload: savePayload() });
        if (!receipt?.draft || !receipt.item || receipt.draft.id !== originalDraftId) {
          pendingSave.current = null;
          setReleaseError("草稿保存尚未确认，请核对结果后再发布。");
          return;
        }
        saved = receipt;
        pendingSave.current = null; setBaseline(snapshot);
      }
      if (!live.current) return;
      if (canonicalize(modelRef.current) !== snapshot) { setReleaseError("保存期间草稿又有修改，请保存最新内容后再发布。"); return; }
      const version = await adminRequest<{ version: ResourceVersion; media: { id: string; url: string | null }[] }>(`${resourcePath(saved.key)}/versions/${encodeURIComponent(saved.draft!.id)}`);
      if (version.version.id !== saved.draft!.id || version.version.revision !== saved.draft!.revision || !Array.isArray(version.media)) { setReleaseError("草稿版本已变化，请重新读取后再发布。"); return; }
      const available = new Set(version.media.filter(row => Boolean(row.url)).map(row => row.id));
      const missing = extractPlate(modelRef.current.document).mediaIds.filter(id => !available.has(id));
      if (missing.length) { setReleaseMediaIds(missing); setReleaseError(`以下素材尚不可公开：${missing.join("、")}。`); return; }
      if (!live.current) return;
      if (canonicalize(modelRef.current) !== snapshot) { setReleaseError("检查期间草稿又有修改，请保存最新内容后再发布。"); return; }
      editorPage.current?.setAttribute("inert", "");
      setPublishingRequest(true);
      await onWrite("content.resource.publish", { versionId: saved.draft!.id, expectedRevision: saved.item!.revision });
    } catch (failure) { if (live.current) setReleaseError(`发布前检查未完成：${friendlyError(failure)}`); }
    finally { releaseLock.current = false; if (live.current) { setReleaseBusy(false); onPublishProgress?.(false); } }
  };
  useEffect(() => { if (publishingRequest && !busy && !pending) setPublishingRequest(false); }, [publishingRequest, busy, pending]);

  const findMediaBlock = (mediaId: string) => model.document.value.findIndex(function contains(node): boolean {
    return node.mediaId === mediaId || Boolean(node.children?.some(contains));
  });
  const issueLocation = (index: number) => {
    const id = model.document.value[index]?.id;
    if (index < 0) return null;
    return typeof id === "string" && canEdit ? <Button type="button" size="sm" variant="ghost" onClick={() => {
      setIssuesOpen(false); setPreview(false);
      requestAnimationFrame(() => { try { if (!editorRef.current?.focusBlock(id)) setReleaseError("该内容块已变化，请重新检查正文。"); } catch { setReleaseError("无法定位该内容块，请重新检查正文。"); } });
    }}>定位到正文第 {index + 1} 块</Button> : <span>正文第 {index + 1} 块</span>;
  };

  const rememberEditorPosition = () => {
    const current = window.getSelection();
    if (current?.rangeCount && editorPage.current?.contains(current.getRangeAt(0).commonAncestorContainer)) selection.current = current.getRangeAt(0).cloneRange();
    const positions: { element: Element; top: number; left: number }[] = [];
    for (let element: Element | null = editorPage.current; element; element = element.parentElement) positions.push({ element, top: element.scrollTop, left: element.scrollLeft });
    scrollPositions.current = positions;
  };
  useLayoutEffect(() => {
    if (preview) { wasPreview.current = true; return; }
    if (!wasPreview.current) return;
    wasPreview.current = false;
    if (lastFocused.current?.isConnected) lastFocused.current.focus({ preventScroll: true });
    if (selection.current?.commonAncestorContainer.isConnected) {
      const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(selection.current);
    }
    for (const position of scrollPositions.current) { position.element.scrollTop = position.top; position.element.scrollLeft = position.left; }
  }, [preview]);

  const savePhase: ContentSavePhase = conflict ? "conflict" : busy ? "saving" : operationError && dirty ? "failed" : dirty ? "dirty" : detail.draft ? "saved" : "idle";
  const historyDocument = history && (history.payload.kind === "guide" || history.payload.kind === "notice") ? readPlateDocument(history.payload, resourcePreset(history.payload.kind)).document : null;

  const historyProjection = historyDocument && extractPlate(historyDocument);
  const historyUrls = Object.fromEntries(history?.media.flatMap(row => row.url ? [[row.id, row.url]] : []) ?? []);
  const chosenVersion = detail.versions.find(version => version.id === historySelection);
  const relatedCandidates = relatedOptions.filter(option => option.slug !== (initial as { slug?: string }).slug);
  const matchedRelated = relatedQuery.trim() ? relatedCandidates.filter(option => option.title.toLowerCase().includes(relatedQuery.trim().toLowerCase())) : relatedCandidates;
  const draftState = detail.draft?.state ?? null;
  const pendingApproval = draftState === "PENDING" || draftState === "PENDING_APPROVAL" || draftState === "IN_REVIEW";
  const canDiscard = kind === "guide" && Boolean(detail.draft) && Boolean(detail.published) && canEdit && !conflict;
  const discardReason = !detail.published ? "文章还没有线上版本。可继续编辑，或将文章移到回收站。"
    : conflict ? "请先重新读取最新内容。" : "";
  const onlineLabel = detail.published ? `线上 v${detail.published.sequence}`
    : detail.current.state === "withdrawn" ? "已撤回"
      : detail.current.source === "BUILTIN" ? "内置内容" : "未发布";
  const onlineTone = detail.published ? "success" : detail.current.state === "withdrawn" ? "warning" : "unknown";
  const helpMode = preview ? "草稿预览" : editable && !conflict && !pendingPublish && !publishingRequest && !versionTransition ? "正在编辑草稿" : detail.draft && !conflict ? "草稿只读" : "只读";
  const versionAction = async (operation: ContentOperation, body: Record<string, unknown>) => {
    setVersionTransition(true);
    try { await onWrite(operation, body); }
    finally { if (live.current) setVersionTransition(false); }
  };

  const versionStatus = (
    <div className="content-doc-status" role="group" aria-label="版本状态">
      {!inHelpWorkspace ? <span className="content-doc-kind">{kind === "guide" ? "帮助手册" : "流程说明"}</span> : null}
      <Badge variant={onlineTone}>{onlineLabel}</Badge>
      {inHelpWorkspace ? <Badge variant={helpMode === "正在编辑草稿" ? "info" : "unknown"}>{helpMode}</Badge>
        : detail.draft ? <Badge variant={pendingApproval ? "warning" : "info"}>{pendingApproval ? "待审批" : `草稿 v${detail.draft.sequence}`}</Badge> : null}
      {!inHelpWorkspace ? <Badge variant={checkError || inspection?.blocking || !publishCheck.ok ? "destructive" : checking ? "unknown" : "success"}>{checkStatus}</Badge> : null}
    </div>
  );
  const saveStatus = <ContentSaveStatus phase={savePhase} savedAt={detail.draft?.updatedAt ?? null} message={operationError} />;
  const saveButton = editable && !conflict && (!inHelpWorkspace || dirty)
    ? <Button type="button" size="sm" variant="secondary" disabled={locked || releaseBusy || !dirty || Boolean(invalid)} onClick={save}>保存草稿</Button> : null;
  const publishButton = canPublish && !conflict && (!inHelpWorkspace || detail.draft)
    ? <Button type="button" size="sm" disabled={!canRelease} onClick={() => inHelpWorkspace ? void publishHelp() : void onWrite("content.resource.publish", { versionId: detail.draft!.id, expectedRevision: detail.item!.revision })}>{busy || releaseBusy ? "处理中…" : inHelpWorkspace ? "发布" : "发布到用户页面"}</Button> : null;
  const startDraftButton = needsDraft && canEdit
    ? <Button type="button" size="sm" disabled={locked} onClick={() => void onWrite("content.resource.draft.create", {})}>{inHelpWorkspace ? "开始编辑" : "创建草稿后编辑"}</Button> : null;
  const recoverButton = pending && !busy && onRecover
    ? <Button type="button" size="sm" variant="secondary" onClick={() => { setReleaseError(undefined); setReleaseMediaIds([]); onRecover(); }}>核对原操作结果</Button> : null;
  const showReleaseBlock = canPublish && !canRelease && (!inHelpWorkspace || Boolean(detail.draft && !dirty && !locked));
  const releaseMessage = !conflict && showReleaseBlock ? releaseReason : "";

  const settingsContent = <>{kind === "guide" ? <fieldset disabled={readOnly} className="content-settings-panel">
      <div className="content-settings-item">
        <ContentText label="摘要" value={model.summary} onChange={summary => patch({ summary })} max={500} multiline />
        <p className="content-settings-help">在列表和搜索结果中展示的一句话简介，最多 500 字。</p>
      </div>
      {!inHelpWorkspace ? <div className="content-settings-item">
        <ContentField label="所属分类" hint="决定文章在帮助中心的归类。"><ContentSelect ariaLabel="所属分类" value={model.category} onChange={category => patch({ category })} disabled={readOnly} options={Object.entries(RESOURCE_CATEGORY_LABEL).map(([value, label]) => ({ value, label }))} /></ContentField>
      </div> : null}
      <div className="content-settings-item">
        <span className="content-settings-label" id="content-audience-label">适用对象</span>
        <div className="content-settings-audience" role="group" aria-labelledby="content-audience-label">{(["all", "renter", "owner"] as const).map((value, index) => <label key={value} className="content-check"><Checkbox disabled={readOnly} id={`audience-${value}`} checked={model.audience.includes(value)} onCheckedChange={checked => patch({ audience: checked === true ? [...model.audience, value] : model.audience.filter(item => item !== value) })} />{["所有用户", "租客", "号主"][index]}</label>)}</div>
        <p className="content-settings-help">在帮助页标明适用对象；此设置不限制文章访问。</p>
      </div>
      <div className="content-settings-item">
        <ContentField label="搜索关键词" hint="用于帮助中心搜索，每个最多 100 字。"><ContentKeywordChips value={model.keywords} onChange={keywords => patch({ keywords })} disabled={readOnly} max={30} maxLength={100} /></ContentField>
      </div>
      <div className="content-settings-item">
        <div className="content-related-heading"><span className="content-settings-label" id="help-related-label">相关阅读</span>{inHelpWorkspace ? <span className="content-settings-help">已选 {model.related.length} 篇</span> : null}</div>
        <p className="content-settings-help">所选文章会显示在正文末尾。</p>
        {inHelpWorkspace && relatedCandidates.length ? <div className="help-related-search"><Search size={15} aria-hidden="true" /><Input aria-label="搜索相关阅读" type="search" placeholder="搜索文章标题" value={relatedQuery} onChange={event => setRelatedQuery(event.target.value)} /></div> : null}
        <div className="content-related-list" role="group" aria-labelledby="help-related-label">
          {matchedRelated.map(option => <label key={option.slug} className="content-related-row">
            <Checkbox disabled={readOnly} id={`related-${option.slug}`} checked={model.related.includes(option.slug)} onCheckedChange={checked => patch({ related: checked === true ? [...model.related, option.slug] : model.related.filter(item => item !== option.slug) })} />
            <span className="content-related-title">{option.title}</span>
          </label>)}
          {!matchedRelated.length ? <span className="content-related-empty">{relatedCandidates.length ? "未找到匹配的文章。" : "有其他文章后即可添加相关阅读。"}</span> : null}
        </div>
      </div>
      <div className="content-settings-item">
        <label className="content-check"><Checkbox disabled={readOnly} id="guide-contact-cta" checked={model.contactCta} onCheckedChange={checked => patch({ contactCta: checked === true })} />显示联系客服入口</label>
        <p className="content-settings-help">开启后在文章末尾显示联系客服入口，方便用户求助。</p>
      </div>
    </fieldset> : <p className="content-settings-note">这段说明用于固定业务位置；报价、资格和订单条款仍由对应业务模块维护。</p>}</>;
  const historyContent = <><div className="mt-4 space-y-4">{!inHelpWorkspace ? <p className="text-xs text-muted-foreground break-all">{detail.key} · 并发版本 {detail.item?.revision ?? "未创建"}</p> : null}{historyLoading ? <p className="text-sm" role="status">读取历史版本…</p> : null}<StatusMessage error={historyError} /><div className="table-wrap"><table className="data-table"><thead><tr><th>版本</th><th>状态</th><th>发布 / 更新时间</th><th>操作</th></tr></thead><tbody>{detail.versions.map(version => <tr key={version.id}><td>v{version.sequence}</td><td>{{ PUBLISHED: "线上", DRAFT: "草稿", SUPERSEDED: "历史", WITHDRAWN: "已撤回" }[version.state] ?? version.state}</td><td className="text-[11px]"><span className="block">{version.publishedAt ? `发布 ${contentTime(version.publishedAt)}` : "未发布"}</span><span className="block text-muted-foreground">更新 {contentTime(version.updatedAt)}</span></td><td><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={historyLoading} onClick={() => void readHistory(version)}>查看原版本</Button>{version.state !== "DRAFT" && canEdit ? <Button type="button" size="sm" variant="secondary" disabled={locked} onClick={() => setRestore(version)}><FileClock size={13} aria-hidden="true" />恢复为草稿</Button> : null}</div></td></tr>)}</tbody></table></div>{detail.published && canPublish ? <Button type="button" size="sm" variant="danger" disabled={locked || dirty} onClick={() => setWithdraw(true)}>撤回线上版本</Button> : null}</div></>;

  return <section className={inHelpWorkspace ? "help-editor content-document-editor content-notion-editor" : "section-panel content-document-editor content-notion-editor"} aria-label="内容编辑器">
    {inHelpWorkspace ? (
      <header className="help-editor-toolbar">
        <div className="help-editor-location">
          <span title={helpDirectoryLabel}>{helpDirectoryLabel}</span>
          {versionStatus}
        </div>
        <div className="help-editor-actions">
          {saveStatus}{recoverButton}{saveButton}
          {detail.draft && (canEdit || canPublish) ? <Button type="button" size="sm" variant="secondary" aria-pressed={preview} onMouseDown={() => { if (!preview) rememberEditorPosition(); }} onClick={() => { if (!preview) rememberEditorPosition(); setPreview(value => !value); }}>{preview ? editable ? "返回编辑" : "返回草稿" : "草稿预览"}</Button> : null}
          {detail.published && publicUrl ? <a className="help-online-link" href={publicUrl} target="_blank" rel="noopener noreferrer">查看线上</a> : null}
          {startDraftButton}{publishButton}
          {canPublish && detail.draft && !releaseBusy && (!canRelease || releaseError) ? <Button type="button" size="sm" variant="ghost" onClick={() => setIssuesOpen(true)}>查看发布问题</Button> : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" size="icon-sm" variant="ghost" disabled={releaseBusy} />} aria-label="文章操作"><MoreHorizontal size={16} aria-hidden="true" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onReload ? <DropdownMenuItem disabled={locked} onClick={onReload}>重新读取</DropdownMenuItem> : null}
              {canEdit ? <DropdownMenuItem onClick={() => { setRelatedQuery(""); setSettingsOpen(true); }}>文章设置</DropdownMenuItem> : null}
              {canViewHistory ? <DropdownMenuItem onClick={openHistory}>版本历史</DropdownMenuItem> : null}
              {canDiscard ? <DropdownMenuItem variant="destructive" disabled={locked} onClick={() => setDiscard(true)}>丢弃草稿</DropdownMenuItem> : null}
              <DropdownMenuItem disabled={locked} onClick={onClose}>关闭文章</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    ) : (
      <div className="content-heading content-editor-head">
        <div className="min-w-0">
          {!hideBackButton ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />返回文档列表</Button> : null}
          {versionStatus}
          <p className="content-item-sub">{detail.definition?.locations.join(" · ") || (kind === "notice" ? "页面说明" : "帮助中心")}{!hideBackButton ? ` · ${detail.key}` : null}</p>
        </div>
        {onReload ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onReload}>重新读取</Button> : null}
      </div>
    )}
    <div className={inHelpWorkspace ? "help-editor-feedback" : "space-y-2"}>
    {!inHelpWorkspace && needsDraft ? <div className="content-readonly-banner"><ShieldAlert size={16} aria-hidden="true" /><div><strong>{detail.current.state === "withdrawn" ? "线上内容已撤回" : "线上版本只读"}</strong><p>{detail.current.state === "withdrawn" ? "创建草稿或从版本历史恢复后可编辑。" : "创建草稿后即可修改正文。"}</p></div>{startDraftButton}</div> : null}
    {inHelpWorkspace && needsDraft && canEdit && !conflict ? <p className="help-editor-release-note">点「开始编辑」创建草稿。发布后，用户才能看到修改。</p> : null}
    {conflict ? <div className="content-conflict-banner" role="alert"><TriangleAlert size={16} aria-hidden="true" /><div><strong>别人刚改过，刷新后再改</strong><p>自动保存已停止；编辑器只读，当前本地内容保留可复制。重新读取会加载最新版本。</p></div>{onReload ? <Button type="button" size="sm" variant="secondary" disabled={locked} onClick={onReload}>重新读取</Button> : null}</div> : null}
    {!canEdit && !inHelpWorkspace ? <StatusMessage tone="warning" error={canPublish ? "当前账号不能编辑或保存；可按发布权限处理已有草稿。" : "当前账号只能查看，不能保存或发布。"} /> : null}
    <FloatingStatusMessage error={!conflict && !pending ? operationError : undefined} success={success} />
    {checkError ? <div className="space-y-2"><StatusMessage error={checkError} /><Button type="button" size="sm" variant="secondary" disabled={checking} onClick={() => setCheckNonce(value => value + 1)}>重新检查正文</Button></div> : null}
    {pending && !busy ? <StatusMessage tone="warning" error="上次操作结果待核对；原请求已保留。" /> : null}
      {inHelpWorkspace && releaseMessage ? <p className="help-editor-release-note" role="status">{releaseMessage}</p> : null}
    </div>
    {!inHelpWorkspace ? <div className="content-editor-actions content-editor-actions-top">
      <div>{saveStatus}{releaseMessage ? <p className="text-xs text-muted-foreground">{releaseMessage}</p> : null}</div>
      <div>
        {recoverButton}{saveButton}{publishButton}
        {detail.draft && canEdit && !conflict ? <Button type="button" variant="ghost" disabled={locked || !canDiscard} title={discardReason || undefined} onClick={() => setDiscard(true)}><Trash2 size={14} aria-hidden="true" />丢弃草稿</Button> : null}
      </div>
    </div> : null}
    {!inHelpWorkspace && detail.draft && canEdit ? <p className="content-draft-escape-note">{kind === "notice" ? "页面说明通过协议条款审批发布。" : discardReason}</p> : null}

    {preview ? (
      <article className="content-notion-page help-article-preview" aria-label="用户端预览">
        {inHelpWorkspace ? <div className="help-preview-context"><span>{helpDirectoryLabel} / {model.title || "无标题"}</span><strong>草稿预览 · 尚未发布</strong></div> : null}
        <h1>{model.title || "无标题"}</h1>
        {model.summary ? <p className="help-preview-summary">{model.summary}</p> : null}
        {projection.toc.length >= 3 ? <details className="help-preview-toc"><summary>本页内容</summary><ul>{projection.toc.map(item => <li key={item.id}><a href={`#${item.id}`}>{item.text}</a></li>)}</ul></details> : null}
        <PlateDocument document={model.document} mediaUrls={urls} />
      </article>
    ) : null}
    <div ref={editorPage} className="content-notion-page" hidden={preview} inert={publishingRequest || pendingPublish || versionTransition || undefined} onFocusCapture={event => { if (event.target instanceof HTMLElement) lastFocused.current = event.target; }}>
      {inHelpWorkspace && editorReadOnly ? <h1 className="help-article-title">{model.title || "无标题"}</h1> : <input
        aria-label="文档标题"
        className="content-notion-title"
        placeholder="无标题"
        value={model.title}
        title={model.title}
        maxLength={200}
        disabled={readOnly}
        onChange={event => patch({ title: event.target.value })}
      />}
      <div className="content-notion-body">
        {!canEdit || (inHelpWorkspace && !editable) ? (
          <article className="content-notion-readonly" aria-label="正文只读视图"><PlateDocument document={model.document} mediaUrls={urls} /></article>
        ) : (
          <Suspense fallback={<div role="status" aria-label="编辑器加载中" className="space-y-3 py-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-3/4" /></div>}>
            <PlateEditor ref={attachEditor} key={seed.key} preset={preset} canvas value={seed.value} onChange={onEditorChange} readOnly={editorReadOnly} mediaUrls={urls} onPickImages={!readOnly && canBrowseMedia ? openImagePicker : undefined} />
          </Suspense>
        )}
        {editable ? <p className="content-notion-body-meta"><span className="content-byte-count">正文 {projection.plainText.length} 字 · 图片 {mediaIds.length}</span><span className="text-xs text-muted-foreground">输入 / 插入内容块</span></p> : null}
      </div>
    </div>

    {!inHelpWorkspace && inspection?.issues.length ? <div className="space-y-2 rounded-lg border border-warning/40 p-4" role="status"><p className="font-medium text-sm">{inspection.blocking ? "可保存原稿，处理以下内容后才能发布" : "发布前提示"}</p><ul className="space-y-2 text-sm">{inspection.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul></div> : null}
    {!inHelpWorkspace && !publishCheck.ok && detail.draft ? <StatusMessage tone="warning" error={`发布校验未通过：${publishCheck.errors.slice(0, 5).map(issue => `${issue.path} ${issue.message}`).join("；")}`} /> : null}
    {invalid ? <StatusMessage error={invalid} /> : null}
    <Dialog open={insertMedia} onOpenChange={open => { if (!open) closeImagePicker(); }}>
      <DialogContent size="md" className="help-article-dialog" closeLabel="关闭插入图片" finalFocus={false}>
        <DialogHeader className="help-dialog-header">
          <DialogTitle>插入图片</DialogTitle>
          <DialogDescription>所选图片会插在打开菜单的内容块之后。</DialogDescription>
        </DialogHeader>
        <div className="help-dialog-scroll">
          <StatusMessage error={insertError} />
          {insertMedia ? <ContentMediaField pickerOnly label="选择图片" value={null} hint="" disabled={readOnly}
            canUpload={canUpload} canReview={canReview} onChange={id => { if (id) insertImage(id); }} /> : null}
        </div>
        <DialogFooter className="help-dialog-footer"><Button type="button" variant="secondary" onClick={() => closeImagePicker()}>取消</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {inHelpWorkspace ? <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent size="md" className="help-article-dialog help-settings-dialog" closeLabel="关闭文章设置" initialFocus={false}>
        <DialogHeader className="help-dialog-header">
          <DialogTitle>文章设置</DialogTitle>
          <DialogDescription>{editable ? "设置随草稿自动保存。发布后会更新用户侧文章。" : "正在查看当前设置。开始编辑后可修改。"}</DialogDescription>
        </DialogHeader>
        <div className="help-dialog-scroll">{settingsContent}</div>
        <DialogFooter className="help-dialog-footer help-settings-footer">
          {editable ? saveStatus : null}
          <Button type="button" variant="secondary" onClick={() => setSettingsOpen(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : !preview ? <details className="content-detail-secondary content-doc-settings"><summary>文档设置</summary>{settingsContent}</details> : null}
    {inHelpWorkspace ? <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent size="lg" className="help-article-dialog help-history-dialog" closeLabel="关闭版本历史" initialFocus={false}>
        <DialogHeader className="help-dialog-header">
          <DialogTitle>版本历史</DialogTitle>
          <DialogDescription>选择一条记录查看当时的正文。恢复后可继续编辑草稿。</DialogDescription>
        </DialogHeader>
        {detail.versions.length ? <div className="help-history-layout">
          <ul className="help-history-list" aria-label="文章版本列表">
            {detail.versions.map(version => (
              <li key={version.id}>
                <button type="button" className="help-history-row" aria-pressed={historySelection === version.id} onClick={() => void readHistory(version)}>
                  <span>{version.state === "DRAFT" ? "当前草稿" : version.publishedAt ? `v${version.sequence}` : "旧草稿"}
                    {version.publishedAt ? <span className="help-history-state">{version.state === "PUBLISHED" ? "线上" : version.state === "WITHDRAWN" ? "已撤回" : "历史发布"}</span> : null}
                  </span>
                  <time dateTime={version.publishedAt ?? version.updatedAt}>{contentTime(version.publishedAt ?? version.updatedAt)}</time>
                </button>
              </li>
            ))}
          </ul>
          <div className="help-history-preview" aria-label="版本正文">
            {historyLoading ? <div className="space-y-3" role="status" aria-label="读取版本正文"><Skeleton className="h-7 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>
              : historyError ? <div className="space-y-3"><StatusMessage error={historyError} />{chosenVersion ? <Button type="button" size="sm" variant="secondary" onClick={() => void readHistory(chosenVersion)}>重试</Button> : null}</div>
              : historyDocument && history ? <>
                <h3 className="help-history-title">{history.payload.title}</h3>
                {"summary" in history.payload && history.payload.summary ? <p className="help-preview-summary">{history.payload.summary}</p> : null}
                {historyProjection?.plainText || historyProjection?.mediaIds.length
                  ? <PlateDocument document={historyDocument} mediaUrls={historyUrls} anchorPrefix="help-history-" />
                  : <p className="text-sm text-muted-foreground">此版本的正文为空。</p>}
              </> : null}
          </div>
        </div> : <p className="help-dialog-scroll text-sm text-muted-foreground">保存草稿或发布后，版本会显示在这里。</p>}
        <DialogFooter className="help-dialog-footer">
          {detail.published && canPublish && !dirty ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { setHistoryOpen(false); setWithdraw(true); }}>撤回线上版本</Button> : null}
          {canEdit && historyDocument && history && !["DRAFT", "PUBLISHED"].includes(history.version.state) ? <Button type="button" size="sm" disabled={locked} onClick={() => { setHistoryOpen(false); setRestore(history.version); }}>恢复为草稿</Button> : null}
          <Button type="button" size="sm" variant="secondary" onClick={() => setHistoryOpen(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : canViewHistory && !preview ? <details className="content-detail-secondary"><summary>版本历史</summary>{historyContent}</details> : null}
    <Dialog open={issuesOpen} onOpenChange={setIssuesOpen}><DialogContent><DialogTitle>发布问题</DialogTitle><DialogDescription>处理后可再次发布；草稿仍会保留。</DialogDescription><p className="text-sm">{releaseError || releaseReason}</p>{releaseMediaIds.map(id => <div key={id} className="text-sm">素材 {id} {issueLocation(findMediaBlock(id))}</div>)}{inspection?.issues.length ? <ul className="space-y-2 text-sm">{inspection.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message} {issue.mediaId ? issueLocation(findMediaBlock(issue.mediaId)) : null}</li>)}</ul> : null}{!publishCheck.ok ? <ul className="space-y-2 text-sm">{publishCheck.errors.slice(0, 5).map(issue => { const match = /^\$\.value\[(\d+)\]/.exec(issue.path); return <li key={`${issue.path}:${issue.message}`}>{issue.message} {match ? issueLocation(Number(match[1])) : issue.path}</li>; })}</ul> : null}{checkError ? <Button type="button" size="sm" variant="secondary" disabled={checking} onClick={() => setCheckNonce(value => value + 1)}>重新检查正文</Button> : null}</DialogContent></Dialog>
    <Dialog open={!inHelpWorkspace && Boolean(history)} onOpenChange={open => { if (!open) setHistory(null); }}><DialogContent size="lg"><DialogTitle>历史版本 v{history?.version.sequence}</DialogTitle><DialogDescription>按此版本原有 plate 文档读取。这里只预览，不更改线上版本。</DialogDescription><div className="max-h-[65vh] overflow-auto p-2">{historyDocument ? <PlateDocument document={historyDocument} mediaUrls={Object.fromEntries(history!.media.filter((row): row is { id: string; url: string } => typeof row.url === "string").map(row => [row.id, row.url]))} /> : <p>此版本不是文档。</p>}</div></DialogContent></Dialog>
    <Dialog open={Boolean(restore)} onOpenChange={open => { if (!open) setRestore(null); }}><DialogContent role="alertdialog"><DialogTitle>将 v{restore?.sequence} 恢复为新草稿？</DialogTitle><DialogDescription>{detail.draft || dirty ? "当前工作副本会被替换，已有草稿保留为历史记录。" : "将复制此版本的正文、元数据和媒体引用。"}保存或恢复草稿不会改变线上内容。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setRestore(null)}>取消</Button><Button type="button" disabled={locked} onClick={() => { const value = restore; setRestore(null); if (value) void versionAction("content.resource.draft.restore", { sourceVersionId: value.id, expectedRevision: detail.item!.revision }); }}>恢复为新草稿</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={withdraw} onOpenChange={setWithdraw}><DialogContent role="alertdialog"><DialogTitle>撤回当前线上内容？</DialogTitle><DialogDescription>用户侧将不再读取此版本；历史保留，恢复后需重新发布。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setWithdraw(false)}>取消</Button><Button type="button" variant="danger" disabled={locked} onClick={() => { setWithdraw(false); void versionAction("content.resource.withdraw", { versionId: detail.published!.id, expectedRevision: detail.item!.revision }); }}>确认撤回</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent role="alertdialog"><DialogTitle>丢弃草稿，回到线上版本？</DialogTitle><DialogDescription>{detail.published ? `丢弃后会回到线上 v${detail.published.sequence}。草稿里的全部修改将永久删除。` : discardReason}</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setDiscard(false)}>继续编辑</Button><Button type="button" variant="danger" disabled={locked || !canDiscard} onClick={() => { setDiscard(false); if (canDiscard && detail.draft && detail.item) void versionAction("content.resource.draft.discard", { versionId: detail.draft.id, expectedRevision: detail.item.revision }); }}>确认丢弃</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
