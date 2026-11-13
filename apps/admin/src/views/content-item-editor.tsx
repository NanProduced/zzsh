import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ImagePlus, Send, Settings2, ShieldAlert, TriangleAlert } from "lucide-react";
import { canonicalize, extractPlate, validatePlateDocument, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { updateExposureFacts, plateUpdateSettings, checkPlateUpdatePublication } from './content-update-settings';
import { ContentItemConfirmDialogs, ContentItemDialogs } from "./content-item-dialogs";
import { ContentItemVersionTable } from "./content-item-version-table";
import { ContentMediaField } from './content-resource-fields';
import { contentTime } from './content-resources-model';
import { adminMediaUrl, isPlateEnvelope, readPlateDocument, ContentSaveStatus, type ContentSavePhase, type PlateSeed } from './content-plate';

import PlateEditor from "../components/plate/plate-editor-loader";

import {
  adminRequest,
  AdminApiError,
  friendlyError,
  type ContentGame,
  type ContentItemDetail,
  type ContentItemRow,
  type ContentVersionRow,
} from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

type WithdrawalTarget = { itemId: string; versionId: string; expectedRevision: string };
type WritePhase = "save" | "publish" | "other";
type ItemWrite = {
  path: string;
  method: "POST" | "PUT";
  body: Record<string, unknown>;
  key: string;
  snapshot?: string;
};
import { byteLabel, utf8Bytes } from "./content-item-bytes";
/** 自动保存停顿（Owner 裁定 15：2 秒）。测试经 prop 缩短。 */
const AUTOSAVE_DELAY_MS = 2000;

export function itemStateLabel(item: ContentItemRow): string {
  if (item.published?.updateSettings?.visibleFrom && Date.parse(item.published.updateSettings.visibleFrom) > Date.now()) return "定时可见";
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
  canUploadMedia = false,
  mediaReadable,
  onClose,
  onChanged,
  onDirtyChange,
  onWriteLockChange,
  onReload,
  onSuccess,
  embedded = false,
  focusTitle = false,
  reading = false,
  autosaveDelayMs = AUTOSAVE_DELAY_MS,
}: {
  detail: ContentItemDetail;
  games: ContentGame[];
  canEdit: boolean;
  canPublish: boolean;
  canPublishPlatform?: boolean;
  canUploadMedia?: boolean;
  mediaReadable: boolean;
  onClose: () => void;
  onChanged: (savedDraft?: ContentVersionRow) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
  onReload?: () => void;
  onSuccess?: (message: string) => void;
  embedded?: boolean;
  focusTitle?: boolean;
  reading?: boolean;
  autosaveDelayMs?: number;
}) {
  const item = detail.item;
  const draft = item.draft;
  const published = item.published;
  const source = draft ?? published ?? detail.versions[0];
  const [model, setModel] = useState(() => ({
    title: source?.title ?? "",
    summary: source?.summary ?? "",
    coverMediaId: source?.coverMediaId ?? null,
    updateSettings: plateUpdateSettings(source?.updateSettings ?? {}),
    document: isPlateEnvelope(source?.payload) && source.payload.preset === "update"
      ? source.payload
      : readPlateDocument(source?.payload, "update").document,
  }));
  const [diagnostic, setDiagnostic] = useState<string>(), [checking, setChecking] = useState(false);
  const promotionDiagnostic = (model.updateSettings.tickerEnabled || model.updateSettings.homePopup) && !canPublishPlatform ? "首页展示需要平台发布权限。可以关闭首页展示后发布，或保存草稿交有权限的管理员处理。" : undefined;
  const [bodyMedia, setBodyMedia] = useState<Record<string, string | null>>(source?.bodyMedia ?? {}), [insertBodyMedia, setInsertBodyMedia] = useState(false);
  useEffect(() => {
    let active = true;
    setChecking(true); setDiagnostic(undefined);
    try {
      checkPlateUpdatePublication(item.type, model.updateSettings);
      const result = validatePlateDocument(model.document, { preset: "update", mode: "publish" });
      if (!result.ok) throw new Error(result.errors.slice(0, 5).map(issue => `${issue.path}：${issue.message}`).join('；'));
    } catch (failure) { if (active) setDiagnostic(failure instanceof Error ? failure.message : '正文检查失败'); }
    finally { if (active) setChecking(false); }
    return () => { active = false; };
  }, [model.document, model.updateSettings, item.type]);
  const [sortOrder, setSortOrder] = useState(String(item.sortOrder));
  // 语义比较（键序无关）：Plate 挂载规范化会重排键序，JSON 直比会产生幻影脏态并触发多余自动保存。
  const [baseline, setBaseline] = useState(() => canonicalize(model));
  const [writing, setWriting] = useState<WritePhase | null>(null);
  const busy = writing !== null;
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(() => ({ summary: model.summary, coverMediaId: model.coverMediaId, updateSettings: model.updateSettings }));
  const [withdrawIntent, setWithdrawIntent] = useState<WithdrawalTarget | null>(null);
  const [leaveIntent, setLeaveIntent] = useState<"close" | "reload" | null>(null);
  const withdrawIntentRef = useRef<WithdrawalTarget | null>(null);
  const busyRef = useRef<WritePhase | null>(null);
  const pendingWrite = useRef<ItemWrite | null>(null);
  const mountedRef = useRef(true);
  const targetRef = useRef({ itemId: item.id, versionId: published?.id, expectedRevision: item.revision, canPublish });
  targetRef.current = { itemId: item.id, versionId: published?.id, expectedRevision: item.revision, canPublish };
  const cancelWithdraw = useCallback(() => { withdrawIntentRef.current = null; setWithdrawIntent(null); }, []);
  const scopeGames = useMemo(() => new Map(games.map((game) => [game.id, game.name])), [games]);
  const withdrawnVersion = detail.versions.find(version => version.state === "WITHDRAWN") ?? null;
  const stateLabel = published ? itemStateLabel(item) : draft ? (withdrawnVersion ? "已撤回 · 有草稿" : "草稿") : withdrawnVersion ? "已撤回" : itemStateLabel(item);
  const stateTone = published ? "success" : draft ? (withdrawnVersion ? "warning" : "info") : withdrawnVersion ? "warning" : "unknown";
  const projection = useMemo(() => extractPlate(model.document), [model.document]);
  const titleBytes = utf8Bytes(model.title), summaryBytes = utf8Bytes(model.summary), bodyBytes = utf8Bytes(projection.plainText);
  const overLimit = titleBytes > 200 ? "标题超过 200 字节，保存会被拒绝。" : summaryBytes > 500 ? "摘要超过 500 字节，保存会被拒绝。" : bodyBytes > 20000 ? "正文超过 20000 字节，保存会被拒绝。" : undefined;
  const exposureFacts = updateExposureFacts(published?.updateSettings);
  const readOnlyOnline = canEdit && !draft && Boolean(published);
  const readOnlyWithdrawn = canEdit && !draft && !published && Boolean(withdrawnVersion);
  const dirty = canonicalize(model) !== baseline;
  const settingsDirty = settingsOpen && canonicalize(settingsDraft) !== canonicalize({ summary: model.summary, coverMediaId: model.coverMediaId, updateSettings: model.updateSettings });
  const releaseHint = !canPublish ? canEdit ? "当前账号没有发布权限，可保存草稿交有对应发布权限的管理员处理。" : "当前账号只能查看，不能保存或发布。"
    : readOnlyOnline ? "线上版本只读；先创建草稿并保存，再发布。"
    : readOnlyWithdrawn ? "线上内容已撤回；从版本历史恢复或新建草稿后才能重新发布。"
    : !draft ? "没有待发布草稿；先创建并保存草稿。"
    : checking ? "正在检查正文与展示设置…"
    : diagnostic ? `处理后才能发布：${diagnostic}`
    : promotionDiagnostic ? promotionDiagnostic
    : overLimit ? overLimit
    : !model.title.trim() ? "发布要求标题非空。"
    : undefined;

  useEffect(() => {
    onDirtyChange(dirty || settingsDirty);
  }, [onDirtyChange, dirty, settingsDirty]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);
  useEffect(() => {
    const pending = withdrawIntentRef.current;
    if (pending && (busy || !canPublish || pending.itemId !== item.id || pending.versionId !== published?.id || pending.expectedRevision !== item.revision)) cancelWithdraw();
  }, [busy, canPublish, cancelWithdraw, item.id, item.revision, published?.id]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; withdrawIntentRef.current = null; };
  }, []);

  const write = async <T,>(suffix: string, body: Record<string, unknown>, method: ItemWrite["method"] = "POST", snapshot?: string) => {
    const path = `/content/items/${item.id}${suffix}`;
    const pending = pendingWrite.current;
    if (pending && (pending.path !== path || pending.method !== method || (pending.snapshot === undefined && canonicalize(pending.body) !== canonicalize(body)))) {
      throw new Error("上次操作结果待核对。请重试原操作，或刷新详情核对。");
    }
    const request = pending ?? { path, method, body, key: `idem_${crypto.randomUUID().replaceAll("-", "")}`, snapshot };
    pendingWrite.current = request;
    try {
      const result = await adminRequest<T>(request.path, request.body, request.method, { "idempotency-key": request.key });
      pendingWrite.current = null;
      return { result, snapshot: request.snapshot };
    } catch (failure) {
      if (failure instanceof AdminApiError && failure.status >= 400 && failure.status < 500 && failure.code !== "IDEMPOTENCY_KEY_REUSED") pendingWrite.current = null;
      throw failure;
    }
  };

  const run = async (phase: WritePhase, action: () => Promise<void>, successText: string, conflictText?: string, versionConflict = false): Promise<void> => {
    if (busyRef.current || reading) return;
    busyRef.current = phase;
    onWriteLockChange?.(true);
    cancelWithdraw();
    setWriting(phase);
    setError(undefined);
    setSuccess(undefined);
    try {
      await action();
      if (phase !== "save") {
        if (onSuccess) onSuccess(successText); else setSuccess(successText);
        await onChanged();
      }
    } catch (failure) {
      const isConflict = failure instanceof AdminApiError && (failure.status === 409 || failure.code === "CONFLICT");
      const staleDraft = isConflict && (versionConflict || (phase === "publish" && failure.path?.endsWith("/draft")));
      if (staleDraft) setConflict(true);
      setError(staleDraft ? "草稿版本已变化，请复制当前修改后刷新详情。"
        : conflictText && isConflict ? conflictText : pendingWrite.current && failure instanceof AdminApiError
        ? "操作结果待核对。重试会复用原请求。"
        : failure instanceof Error && !(failure instanceof AdminApiError) ? failure.message : friendlyError(failure));
    } finally {
      busyRef.current = null;
      if (mountedRef.current) {
        setWriting(null);
        onWriteLockChange?.(false);
      }
    }
  };

  const saveCopy = async (version: NonNullable<typeof draft>, copy: typeof model) => {
    const { result, snapshot } = await write<{ version: ContentVersionRow }>("/draft", {
      versionId: version.id, expectedRevision: version.revision, title: copy.title, summary: copy.summary,
      document: copy.document, coverMediaId: copy.coverMediaId, updateSettings: copy.updateSettings,
    }, "PUT", canonicalize(copy));
    const saved = result?.version;
    if (!saved || saved.itemId !== item.id || saved.id !== version.id || saved.state !== "DRAFT"
      || typeof saved.revision !== "string" || !saved.revision || saved.revision === version.revision || snapshot === undefined) {
      throw new Error("草稿保存回执不完整，请刷新详情核对。");
    }
    setBaseline(snapshot);
    await onChanged(saved);
    return { version: saved, snapshot };
  };
  const saveDraft = () => {
    if (!draft || !canEdit || conflict) return;
    if (overLimit) { setError(overLimit); return; }
    void run("save", async () => { await saveCopy(draft, model); }, "草稿已保存。", undefined, true);
  };
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  // 自动保存：停顿 2 秒写草稿；已发布版本不可变（无草稿时只读，需显式建草稿）。
  // 单飞：busy/reading 期间不排程，保存完成后的修改由下一次 effect 重新排程。
  useEffect(() => {
    if (!dirty || !canEdit || !draft || busy || reading || conflict || overLimit || error || settingsOpen) return;
    const timer = setTimeout(() => { saveDraftRef.current(); }, autosaveDelayMs);
    return () => clearTimeout(timer);
  }, [dirty, canEdit, draft, busy, reading, conflict, overLimit, error, settingsOpen, model, autosaveDelayMs]);

  const createDraft = () => {
    if (!canEdit || draft) return;
    void run("other", async () => {
      await write("/draft", {});
    }, "已从当前版本创建新草稿；修改不会影响线上正文。");
  };

  const publish = () => {
    if (!draft || !canPublish || conflict || (dirty && !canEdit)) return;
    const copy = { ...model, document: { ...model.document, value: localValue.current } };
    const snapshot = canonicalize(copy);
    if (checking || diagnostic || promotionDiagnostic || overLimit || !copy.title.trim()) return;
    void run("publish", async () => {
      const saved = snapshot !== baseline ? await saveCopy(draft, copy) : { version: draft, snapshot };
      if (saved.snapshot !== snapshot || canonicalize(localValue.current) !== canonicalize(copy.document.value)) {
        throw new Error("上次草稿已保存，当前修改尚未发布。请核对正文后再次发布。");
      }
      if (!mountedRef.current || targetRef.current.itemId !== item.id || !targetRef.current.canPublish) {
        throw new Error("发布权限或当前内容已变化。请重新打开详情后核对。");
      }
      await write("/publish", { versionId: saved.version.id, expectedRevision: saved.version.revision });
    }, copy.updateSettings.visibleFrom && Date.parse(copy.updateSettings.visibleFrom) > Date.now() ? "已设置定时可见。" : "发布成功。",
    copy.updateSettings.pinned ? "发布未完成。请核对当前版本和置顶名额，同时最多 3 条有效置顶。" : "内容版本或发布条件已变化，请核对详情后重试。");
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
    void run("other", async () => {
      await write("/withdraw", { versionId: pending.versionId, expectedRevision: pending.expectedRevision });
    }, "已下线，版本历史已保留。");
  };

  const saveSort = () => {
    const parsed = Number(sortOrder);
    if (!Number.isInteger(parsed)) {
      setError("排序必须是整数。");
      return;
    }
    void run("other", async () => {
      await write("", { expectedRevision: item.revision, sortOrder: parsed }, "PUT");
    }, "排序已更新。");
  };

  const readOnly = !canEdit || !draft || busy || reading || conflict;
  // 编辑器只读态与“保存中”解耦（缺陷 2）：PlateEditor 的 usePlateEditor 依赖 [preset, readOnly]，
  // busy 计入 readOnly 会在每次保存重建 contenteditable → 闪烁。editorReadOnly 只反映持久状态。
  const editorReadOnly = !canEdit || !draft || reading || conflict || writing === "publish";
  const openSettings = () => {
    setSettingsDraft({ summary: model.summary, coverMediaId: model.coverMediaId, updateSettings: model.updateSettings });
    setSettingsOpen(true);
  };
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

  // PlateEditor 挂载时注入值；editorReadOnly 切换会以最新本地值重挂载，避免丢失输入。
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
    if (busyRef.current === "publish") return;
    localValue.current = envelope.value;
    setModel(current => ({ ...current, document: envelope }));
  };
  const mediaUrls = useMemo(() => Object.fromEntries(Object.entries(bodyMedia).filter((entry): entry is [string, string] => Boolean(entry[1]))), [bodyMedia]);
  const insertImage = (mediaId: string) => {
    const next: PlateNode[] = [...localValue.current, { type: "img", mediaId, alt: "图片说明", children: [{ text: "" }] }];
    localValue.current = next;
    setSeed(current => ({ key: current.key + 1, value: next }));
    setModel(current => ({ ...current, document: { ...current.document, value: next } }));
    setBodyMedia(current => ({ ...current, [mediaId]: adminMediaUrl(mediaId) }));
    setInsertBodyMedia(false);
  };

  const savePhase: ContentSavePhase = conflict ? "conflict" : writing === "save" ? "saving" : error && dirty ? "failed" : dirty ? "dirty" : draft ? "saved" : "idle";

  return (
    <section className={embedded ? "content-item-editor content-notion-editor content-updates-editor" : "section-panel content-item-editor content-notion-editor"} aria-label={item.type === "ANNOUNCEMENT" ? "公告编辑器" : "资讯编辑器"}>
      {!embedded ? <div className="content-heading">
        <div className="min-w-0">
          <Button type="button" size="sm" variant="ghost" disabled={busy || reading} onClick={() => requestLeave("close")}><ArrowLeft size={14} aria-hidden="true" />返回列表</Button>
          <h3 className="mt-2 text-lg font-semibold leading-relaxed">{item.type === "ANNOUNCEMENT" ? "公告编辑" : "资讯编辑"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{model.title || "（无标题）"} · {item.gameId === null ? "平台级" : scopeGames.get(item.gameId) ?? item.gameId} · {item.id}</p>
        </div>
        <div className="content-heading-meta">
          {onReload ? <Button type="button" size="sm" variant="ghost" disabled={busy || reading} onClick={() => requestLeave("reload")}>刷新详情</Button> : null}
        </div>
      </div> : null}
      {!embedded || published ? <div className="content-item-facts">
        <Badge variant={stateTone}>{stateLabel}</Badge>
        {published ? <span>线上 v{published.sequence} · 发布 {contentTime(published.publishedAt)}</span> : withdrawnVersion ? <span>线上 v{withdrawnVersion.sequence} 已撤回</span> : <span>尚无线上版本</span>}
        {draft ? <span>草稿 v{draft.sequence} · 更新 {contentTime(draft.updatedAt)}</span> : <span>无草稿</span>}
        {exposureFacts.map(fact => <Badge key={fact.label} variant={fact.tone}>{fact.label}</Badge>)}
      </div> : null}

      <StatusMessage error={error} success={success} className="mt-3" />
      {conflict ? <div className="content-conflict-banner" role="alert"><TriangleAlert size={16} aria-hidden="true" /><div><strong>别人刚改过，刷新后再改</strong><p>自动保存已停止；编辑器只读，当前本地内容保留可复制。刷新详情会读取最新版本。</p></div>{onReload ? <Button type="button" size="sm" variant="secondary" disabled={busy || reading} onClick={() => requestLeave("reload")}>刷新详情</Button> : null}</div> : null}
      {readOnlyOnline && !conflict ? <div className="content-readonly-banner"><ShieldAlert size={16} aria-hidden="true" /><div><strong>线上版本只读</strong><p>创建新草稿后才能修改；发布前用户页面继续读取 v{published?.sequence}。当前草稿与线上正文互不影响。</p></div><Button type="button" size="sm" loading={busy} disabled={!canEdit || busy || reading} onClick={createDraft}>编辑已发布内容（新建草稿）</Button></div> : null}
      {readOnlyWithdrawn ? <div className="content-readonly-banner"><ShieldAlert size={16} aria-hidden="true" /><div><strong>线上内容已下线</strong><p>可以恢复最近版本为新草稿，编辑后再发布。</p></div></div> : null}
      <div className="content-editor-actions content-editor-actions-top content-item-actions">
        <div>
          {embedded ? <Button type="button" size="sm" variant="ghost" className="content-updates-back" disabled={busy || reading} onClick={() => requestLeave("close")}><ArrowLeft size={14} aria-hidden="true" />返回列表</Button> : null}
        </div>
        <div>
          <ContentSaveStatus phase={savePhase} savedAt={draft?.updatedAt ?? null} message={error ? "草稿未保存" : undefined} />
          {embedded && error && onReload && !conflict ? <Button type="button" size="sm" variant="ghost" disabled={busy || reading} onClick={() => requestLeave("reload")}>刷新详情</Button> : null}
          {canEdit && draft && !conflict ? <Button type="button" size="sm" variant="secondary" loading={busy} disabled={readOnly} onClick={saveDraft}>保存草稿</Button> : null}
          <Button type="button" size="sm" variant="outline" disabled={busy || reading} onClick={openSettings}><Settings2 size={14} aria-hidden="true" />发布设置</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || reading} onClick={() => setPreviewing(value => !value)}>{previewing ? (canEdit && draft ? "继续编辑" : "退出预览") : "预览"}</Button>
          {canEdit && !draft && source && !readOnlyOnline ? <Button type="button" size="sm" variant="secondary" loading={busy} disabled={!canEdit || busy || reading} onClick={createDraft}>{published ? '编辑已发布内容（新建草稿）' : '恢复内容为新草稿'}</Button> : null}
          {draft && canPublish && !conflict ? <Button type="button" size="sm" loading={writing === "publish"} disabled={busy || reading || checking || Boolean(diagnostic || promotionDiagnostic || overLimit) || !model.title.trim() || (dirty && !canEdit)} onClick={publish}><Send size={14} aria-hidden="true" />{embedded ? "发布" : `发布草稿 v${draft.sequence}`}</Button> : null}
          {embedded && published && canPublish ? <Button type="button" size="sm" variant="ghost" disabled={busy || reading} onClick={withdraw}>下线</Button> : null}
          {!canEdit ? <span className="text-[11px] text-muted-foreground self-center">只能查看</span> : null}
        </div>
      </div>
      {overLimit || releaseHint && !(embedded && readOnlyWithdrawn) ? <p className={overLimit ? "content-byte-over" : "text-xs text-muted-foreground"}>{overLimit ?? releaseHint}</p> : null}

      {previewing ? <article className="content-notion-page" aria-label="用户端预览">
        <h3 className="content-notion-title">{model.title || "无标题"}</h3>
        {model.summary ? <p className="mt-3 text-sm text-muted-foreground">{model.summary}</p> : null}
        {model.coverMediaId && mediaReadable ? <img src={adminMediaUrl(model.coverMediaId)} className="mt-4 max-h-64 w-full rounded-md object-contain" alt="封面" /> : null}
        <div className="content-notion-body"><PlateDocument document={model.document} mediaUrls={mediaUrls} /></div>
      </article> : null}
      <div className="content-notion-page" hidden={previewing}>
        <input
          aria-label="文档标题"
          className="content-notion-title"
          placeholder="无标题"
          value={model.title}
          maxLength={200}
          disabled={readOnly}
          autoFocus={focusTitle}
          onChange={(event) => setModel((current) => ({ ...current, title: event.target.value }))}
        />
        <div className="content-notion-body">
          {!canEdit ? (
            <article className="content-notion-readonly" aria-label="正文只读视图"><PlateDocument document={model.document} mediaUrls={mediaUrls} /></article>
          ) : (
            <Suspense fallback={<div role="status" aria-label="编辑器加载中" className="space-y-3 py-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-3/4" /></div>}>
              <PlateEditor key={seed.key} preset="update" canvas value={seed.value} onChange={onEditorChange} readOnly={editorReadOnly} mediaUrls={mediaUrls} />
            </Suspense>
          )}
          {bodyBytes > 18000 ? <p className="content-notion-body-meta"><span className={bodyBytes > 20000 ? "content-byte-over" : "content-byte-count"}>{byteLabel(projection.plainText, 20000)}</span></p> : null}
        </div>
        <div className="content-notion-meta">
          {mediaReadable && canEdit && draft && !conflict ? <div className="content-notion-media">
            <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={() => setInsertBodyMedia(true)}><ImagePlus size={14} aria-hidden="true" />插入图片</Button>
          </div> : null}

        </div>
      </div>

      <ContentItemDialogs
        insertBodyMedia={insertBodyMedia}
        setInsertBodyMedia={setInsertBodyMedia}
        mediaReadable={mediaReadable}
        readOnly={readOnly}
        canUploadMedia={canUploadMedia}
        canPublishPlatform={canPublishPlatform}
        setBodyMedia={setBodyMedia}
        insertImage={insertImage}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        canEdit={canEdit}
        conflict={conflict}
        draft={draft}
        settingsDraft={settingsDraft}
        setSettingsDraft={setSettingsDraft}
        setModel={setModel}
        item={item}
      />
      <details className="content-updates-legacy-sort"><summary>旧接口排序</summary>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">旧接口排序（平台动态按发布时间及有效置顶排列）</span>
                <div className="flex gap-2">
                  <Input value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} className="h-9 text-sm" inputMode="numeric" disabled={!canEdit || busy || reading} />
                  <Button type="button" size="sm" variant="secondary" loading={busy} disabled={!canEdit || busy || reading} onClick={saveSort}>保存排序</Button>
                </div>
              </label>
      </details>
      {diagnostic ? <StatusMessage tone="warning" error={`可保存草稿，处理后才能发布：${diagnostic}`} className="mt-3" /> : null}
      {promotionDiagnostic ? <StatusMessage tone="warning" error={promotionDiagnostic} className="mt-3" /> : null}
      <ContentItemVersionTable versions={detail.versions} published={published} canPublish={canPublish} embedded={embedded} busy={busy} onWithdraw={withdraw} />
      <ContentItemConfirmDialogs
        withdrawIntent={withdrawIntent}
        cancelWithdraw={cancelWithdraw}
        busy={busy}
        reading={reading}
        canPublish={canPublish}
        confirmWithdraw={confirmWithdraw}
        embedded={embedded}
        leaveIntent={leaveIntent}
        setLeaveIntent={setLeaveIntent}
        confirmLeave={confirmLeave}
      />
    </section>
  );
}
