import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Plus, RefreshCw, Save, Send, Undo2 } from "lucide-react";
import { RESOURCE_DEFINITIONS } from "@zzsh/content";
import { canonicalize, extractPlate, plateDigest, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";

import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { formatBeijingDateTime } from "../workspace/beijing-time";
import { ContentResourcesTab } from "./content-resources-tab";
import { resourcePath, type ResourceDetail, type ResourcePage } from "./content-resources-model";
import { ContentSaveStatus, emptyPlateDocument } from "./content-plate";
import "./legal-documents.css";

import PlateEditor from "../components/plate/plate-editor-loader";

type DocType = "PLATFORM_TERMS" | "PLATFORM_PRIVACY" | "EARLY_SETTLEMENT";
type LegalVersion = {
  id: string;
  docType: DocType;
  title: string;
  body: string;
  bodyFormat: "text" | "plate";
  bodyDocument: PlateDocumentEnvelope | null;
  digest: string;
  status: "DRAFT" | "PENDING" | "SEALED";
  revision: string;
  effectiveAt: string | null;
  sealedAt: string | null;
  approvalRequestId: string | null;
  createdAt: string;
};
type LegalList = { versions: LegalVersion[]; current?: LegalVersion[] };
type DiffBlock = { status: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED"; before: string | null; after: string | null };
type DiffResult = { draft: LegalVersion; current: LegalVersion | null; blocks: DiffBlock[] };
type NoticeOption = { key: string; title: string };
type SubmitItem = { kind: DocType | "NOTICE"; key: string; draftVersionId: string; digest: string; baseVersionId: string | null };
type Mode = "edit" | "preview" | "compare";
type WorkbenchSection = DocType | "notices";
type DraftForm = { title: string; body: string; document: PlateDocumentEnvelope };
type ReleaseTarget = { version: LegalVersion } | { notice: ResourceDetail };
type WriteCommand = {
  action: "save" | "submit" | "return";
  path: string;
  method: "POST" | "PUT";
  body: Record<string, unknown>;
  key: string;
  versionId?: string;
};

const DOC_LABELS: Record<DocType, string> = {
  PLATFORM_TERMS: "平台服务协议",
  PLATFORM_PRIVACY: "用户隐私政策",
  EARLY_SETTLEMENT: "提前结算告知",
};
const PLATFORM_TYPES = ["PLATFORM_TERMS", "PLATFORM_PRIVACY"] as const;
const DOC_TYPES = [...PLATFORM_TYPES, "EARLY_SETTLEMENT"] as const;
const NOTICE_GROUPS = [
  { group: "publish", label: "上架出租" },
  { group: "rental", label: "账号详情" },
] as const;
const NOTICE_DEFINITIONS = RESOURCE_DEFINITIONS.filter(definition => definition.kind === "notice" && definition.key !== "placement:RENTAL_PROCESS");
const CHANGE_LABELS: Record<DiffBlock["status"], string> = { ADDED: "新增", REMOVED: "删除", CHANGED: "修改", UNCHANGED: "未变" };
const NO_GAMES: [] = [];

function versionLabel(version: LegalVersion, live: LegalVersion | undefined): string {
  if (version.id === live?.id) return "当前生效";
  if (version.status === "DRAFT") return "草稿";
  if (version.status === "PENDING") return "已提交审批";
  return version.effectiveAt && Date.parse(version.effectiveAt) > Date.now() ? "待生效" : "历史版本";
}

function formFor(version?: LegalVersion, drafting = false): DraftForm {
  const empty = emptyPlateDocument("legal");
  const legacyText = drafting && version?.bodyFormat === "text" && version.docType !== "EARLY_SETTLEMENT";
  const document = version?.bodyDocument ?? (legacyText ? {
    ...empty,
    value: version.body.split(/\r?\n/).map(text => ({ type: "p", children: [{ text }] })),
  } : empty);
  return { title: version?.title ?? "", body: version?.body ?? "", document };
}

function supportsDraft(version: LegalVersion): boolean {
  return version.status === "DRAFT" && version.bodyFormat === (version.docType === "EARLY_SETTLEMENT" ? "text" : "plate");
}

function draftBody(type: DocType, form: DraftForm) {
  return type === "EARLY_SETTLEMENT" ? { title: form.title.trim(), body: form.body }
    : { title: form.title.trim(), bodyDocument: form.document };
}

function UserPreview({ version }: { version: Pick<LegalVersion, "body" | "bodyFormat" | "bodyDocument"> }) {
  if (version.bodyFormat === "plate" && version.bodyDocument) {
    return <article className="content-notion-readonly" aria-label="用户端预览"><PlateDocument document={version.bodyDocument} /></article>;
  }
  return <article className="fixed-doc-preview-text" aria-label="用户端预览">
    {version.body.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
  </article>;
}

function changedText(before: string, after: string) {
  const left = Array.from(before);
  const right = Array.from(after);
  const common = Math.min(left.length, right.length);
  let start = 0;
  let end = 0;
  while (start < common && left[start] === right[start]) start += 1;
  while (end < common - start && left[left.length - end - 1] === right[right.length - end - 1]) end += 1;
  return {
    prefix: left.slice(0, start).join(""),
    removed: left.slice(start, left.length - end).join(""),
    added: right.slice(start, right.length - end).join(""),
    suffix: left.slice(left.length - end).join(""),
  };
}

export function DiffBlocks({ blocks, emptyText, beforeLabel = "当前生效", afterLabel = "提交版本" }: {
  blocks: DiffBlock[]; emptyText: string; beforeLabel?: string; afterLabel?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const changed = blocks.filter(block => block.status !== "UNCHANGED");
  const visible = showAll ? blocks : changed;
  if (!blocks.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return <div aria-label="与线上差异" className="fixed-doc-diff">
    <div className="fixed-doc-diff-header">
      <p role="status">{changed.length} 处正文变更</p>
      {changed.length < blocks.length ? <label className="flex items-center gap-2 text-sm">
        显示全文 <Switch aria-label="显示全文" checked={showAll} onCheckedChange={setShowAll} />
      </label> : null}
    </div>
    {visible.length ? <ul className="fixed-doc-diff-list">
      {visible.map((block, index) => {
        if (block.status === "UNCHANGED") return <li key={index} className="fixed-doc-diff-context">{block.before ?? block.after}</li>;
        const change = changedText(block.before ?? "", block.after ?? "");
        return <li key={index} className="fixed-doc-change" data-change={block.status}>
          <Badge variant={block.status === "ADDED" ? "success" : block.status === "REMOVED" ? "destructive" : "warning"}>{CHANGE_LABELS[block.status]}</Badge>
          <div className="fixed-doc-change-grid">
            <div><p className="fixed-doc-change-label">{beforeLabel}</p><p>{block.before === null ? "无此段落" : <>
              {change.prefix}{change.removed ? <del>{change.removed}</del> : null}{change.suffix}
            </>}</p></div>
            <div><p className="fixed-doc-change-label">{afterLabel}</p><p>{block.after === null ? "已删除" : <>
              {change.prefix}{change.added ? <ins>{change.added}</ins> : null}{change.suffix}
            </>}</p></div>
          </div>
        </li>;
      })}
    </ul> : <p className="text-sm text-muted-foreground">两个版本的正文文字一致。</p>}
  </div>;
}

async function noticeItem(detail: ResourceDetail): Promise<SubmitItem> {
  const draft = detail.draft;
  if (!draft || draft.payload?.kind !== "notice") throw new Error("请先保存场景说明草稿。");
  const document = draft.payload.document;
  if (!validatePlateDocument(document, { preset: "notice", mode: "publish" }).ok) throw new Error(`「${draft.title}」的正文未通过发布校验，请先修正草稿。`);
  return { kind: "NOTICE", key: detail.key, draftVersionId: draft.id, digest: await plateDigest(document), baseVersionId: detail.published?.id ?? null };
}

type PanelProps = {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  refreshNonce?: number;
  onDirtyChange?: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
  onOpenPath?: (path: string) => void;
};

export function LegalDocumentsPanel({ snapshot, refreshNonce = 0, onDirtyChange, onWriteLockChange, onOpenPath }: PanelProps) {
  const canEdit = hasPermission(snapshot, "content.platform.edit");
  const canReturn = hasPermission(snapshot, "content.fixed.submit");
  const canSubmit = canReturn && hasPermission(snapshot, "approval.request.create");
  const canReadNotices = hasPermission(snapshot, "content.platform.read");
  const canOpenApproval = hasPermission(snapshot, "approval.request.read") || canSubmit || hasPermission(snapshot, "content.fixed.publish");
  const [section, setSection] = useState<WorkbenchSection>("PLATFORM_TERMS");
  const [noticeKey, setNoticeKey] = useState("");
  const [records, setRecords] = useState<LegalList>({ versions: [] });
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState(() => formFor());
  const [baseline, setBaseline] = useState("");
  const [creating, setCreating] = useState(false);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [mode, setMode] = useState<Mode>("preview");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<WriteCommand["action"] | null>(null);
  const [error, setError] = useState<string>();
  const [noticeDirty, setNoticeDirty] = useState(false);
  const [noticeLocked, setNoticeLocked] = useState(false);
  const [noticesRefresh, setNoticesRefresh] = useState(0);
  const [deferred, setDeferred] = useState<(() => void) | null>(null);
  const [conflict, setConflict] = useState(false);
  const [failedBody, setFailedBody] = useState("");
  const [pending, setPending] = useState<WriteCommand | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffError, setDiffError] = useState<string>();
  const [diffAttempt, setDiffAttempt] = useState(0);
  const [target, setTarget] = useState<ReleaseTarget | null>(null);
  const [reason, setReason] = useState("");
  const [noticeOptions, setNoticeOptions] = useState<NoticeOption[]>([]);
  const [noticeKeys, setNoticeKeys] = useState<string[]>([]);
  const [noticeOptionsFailed, setNoticeOptionsFailed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitted, setSubmitted] = useState<string>();
  const readSequence = useRef(0);
  const operationActive = useRef(false);
  const alive = useRef(true);
  const mounted = useRef({ adminId: snapshot.adminUserId, sessionId: snapshot.session.id });
  mounted.current = { adminId: snapshot.adminUserId, sessionId: snapshot.session.id };

  const docType = section === "notices" ? null : section;
  const current = docType ? records.current?.find(version => version.docType === docType) : undefined;
  const docVersions = records.versions.filter(version => version.docType === docType);
  const selected = docVersions.find(version => version.id === selectedId);
  const latestDraft = docVersions.find(supportsDraft);
  const selectedLabel = selected ? versionLabel(selected, current) : "新草稿";
  const selectedDraft = selected && supportsDraft(selected) ? selected : undefined;
  const editable = Boolean(docType && canEdit && (creating || selectedDraft));
  const working = useMemo(() => docType ? canonicalize(draftBody(docType, form)) : "", [docType, form]);
  const dirty = editable && working !== baseline;
  const writeLocked = Boolean(busy || preparing || pending || noticeLocked);
  const canCompare = Boolean(selected && selected.id !== current?.id);
  const compareId = mode === "compare" && canCompare && !dirty ? selected?.id : undefined;
  const plainBody = useMemo(() => docType === "EARLY_SETTLEMENT" ? form.body : extractPlate(form.document).plainText, [docType, form.body, form.document]);
  const invalid = !form.title.trim() ? "请填写标题。"
    : !plainBody.trim() ? "请填写正文。"
      : new TextEncoder().encode(plainBody).length > 20_000 ? "正文不能超过 20,000 字节。"
        : docType !== "EARLY_SETTLEMENT" && !validatePlateDocument(form.document, { preset: "legal", mode: "draft" }).ok ? "请检查正文排版与长度。" : undefined;
  const publishReady = docType === "EARLY_SETTLEMENT" || validatePlateDocument(form.document, { preset: "legal", mode: "publish" }).ok;
  const bothPlatformLive = PLATFORM_TYPES.every(type => records.current?.some(version => version.docType === type));

  useEffect(() => { alive.current = true; return () => { alive.current = false; ++readSequence.current; }; }, []);
  useEffect(() => { onDirtyChange?.(dirty || noticeDirty); }, [dirty, noticeDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onWriteLockChange?.(writeLocked); }, [writeLocked, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);

  const select = useCallback((version?: LegalVersion, view?: Mode) => {
    const next = formFor(version);
    setSelectedId(version?.id ?? "");
    setForm(next);
    setBaseline(version ? canonicalize(draftBody(version.docType, next)) : "");
    setCreating(false);
    if (view === "compare" && version) setMode("compare");
    else if (view !== "preview" && canEdit && version && supportsDraft(version)) setMode("edit");
    else setMode("preview");
    setSubmitted(undefined);
    setConflict(false);
    setFailedBody("");
    setError(undefined);
    setEditorGeneration(value => value + 1);
  }, [canEdit]);

  const read = async () => {
    const seq = ++readSequence.current;
    const identity = mounted.current;
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await adminRequest<LegalList>("/legal-documents");
      if (!alive.current || seq !== readSequence.current || mounted.current.adminId !== identity.adminId || mounted.current.sessionId !== identity.sessionId) return;
      const versions = result.versions;
      const active = result.current ?? DOC_TYPES.flatMap(type => {
        const live = versions.filter(version => version.docType === type && version.status === "SEALED"
          && version.effectiveAt && Date.parse(version.effectiveAt) <= Date.now())
          .sort((a, b) => Date.parse(b.effectiveAt!) - Date.parse(a.effectiveAt!))[0];
        return live ? [live] : [];
      });
      const merged = [...versions, ...active.filter(version => !versions.some(row => row.id === version.id))];
      setRecords({ versions: merged, current: active });
      if (docType) {
        const live = active.find(version => version.docType === docType);
        const previous = merged.find(version => version.docType === docType && version.id === selectedId);
        const previousView = previous && mode === "compare" && previous.id === live?.id ? "preview" : mode;
        select(previous ?? live ?? merged.find(version => version.docType === docType), previous ? previousView : undefined);
      }
    } catch (failure) {
      if (alive.current && seq === readSequence.current) setLoadError(friendlyError(failure));
    } finally {
      if (alive.current && seq === readSequence.current) setLoading(false);
    }
  };
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    setPending(null);
    setTarget(null);
    setDeferred(null);
    setBusy(null);
    setPreparing(false);
    void readRef.current();
  }, [snapshot.adminUserId, snapshot.session.id]);
  const lastRefresh = useRef(refreshNonce);
  useEffect(() => {
    if (lastRefresh.current === refreshNonce) return;
    lastRefresh.current = refreshNonce;
    if (!dirty && !noticeDirty && !writeLocked) void readRef.current();
  }, [refreshNonce, dirty, noticeDirty, writeLocked]);

  useEffect(() => {
    setDiff(null);
    setDiffError(undefined);
    if (!compareId) return;
    const controller = new AbortController();
    void adminRequest<DiffResult>(`/legal-documents/drafts/${encodeURIComponent(compareId)}/diff`, undefined, "GET", {}, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.draft.revision !== selected?.revision || result.draft.status !== selected?.status || (result.current?.id ?? null) !== (current?.id ?? null)) {
        setDiffError("当前版本已变化，请重新读取后再比较。");
      } else setDiff(result);
    }).catch(failure => { if (!controller.signal.aborted) setDiffError(friendlyError(failure)); });
    return () => controller.abort();
  }, [compareId, selected?.revision, selected?.status, current?.id, diffAttempt]);

  const guard = (action: () => void) => {
    if (writeLocked || operationActive.current) return;
    if (dirty || noticeDirty) setDeferred(() => action);
    else action();
  };

  const openSection = (next: WorkbenchSection, nextNoticeKey = "") => {
    if (next === section && (next !== "notices" || nextNoticeKey === noticeKey)) return;
    guard(() => {
      setSection(next);
      setNoticeKey(nextNoticeKey);
      setSubmitted(undefined);
      setNoticeDirty(false);
      setNoticeLocked(false);
      select(next === "notices" ? undefined : records.current?.find(version => version.docType === next)
        ?? records.versions.find(version => version.docType === next));
    });
  };

  const startDraft = () => {
    if (!docType || !canEdit || loading || writeLocked) return;
    guard(() => {
      if (latestDraft) { select(latestDraft); return; }
      const next = formFor(current ?? selected, true);
      if (!next.title) next.title = DOC_LABELS[docType];
      setForm(next);
      setSelectedId("");
      setBaseline(canonicalize(draftBody(docType, next)));
      setCreating(true);
      setError(undefined);
      setConflict(false);
      setFailedBody("");
      setMode("edit");
      setEditorGeneration(value => value + 1);
    });
  };

  const execute = async (command: WriteCommand) => {
    if (operationActive.current) return;
    operationActive.current = true;
    const identity = mounted.current;
    const stillCurrent = () => alive.current && mounted.current.adminId === identity.adminId && mounted.current.sessionId === identity.sessionId;
    setBusy(command.action);
    setError(undefined);
    try {
      const response = await adminRequest<LegalVersion | { approvalRequestId: string }>(command.path, command.body, command.method, { "idempotency-key": command.key });
      if (!stillCurrent()) return;
      if (command.action === "submit") {
        if (!response || !("approvalRequestId" in response) || typeof response.approvalRequestId !== "string" || !response.approvalRequestId) throw new Error("审批回执不完整");
        const requestId = response.approvalRequestId;
        const versionIds = new Set((command.body.items as SubmitItem[]).filter(item => item.kind !== "NOTICE").map(item => item.draftVersionId));
        setRecords(previous => ({ ...previous, versions: previous.versions.map(version => versionIds.has(version.id)
          ? { ...version, status: "PENDING", approvalRequestId: requestId } : version) }));
        setSubmitted(requestId);
        setTarget(null);
        setMode("preview");
        setNoticesRefresh(value => value + 1);
      } else {
        if (!response || !("docType" in response) || !response.id || !response.revision || response.status !== "DRAFT"
          || (command.versionId && response.id !== command.versionId)
          || (!command.versionId && response.docType !== command.body.docType)) throw new Error("草稿回执不完整");
        const saved = response;
        setRecords(previous => ({ ...previous, versions: previous.versions.some(version => version.id === saved.id)
          ? previous.versions.map(version => version.id === saved.id ? saved : version) : [saved, ...previous.versions] }));
        if (command.action === "return") {
          select(saved);
        } else {
          const sentBody = { title: command.body.title, ...(saved.docType === "EARLY_SETTLEMENT"
            ? { body: command.body.body } : { bodyDocument: command.body.bodyDocument }) };
          // 保存回执可能规范化空白，保留编辑器输入和光标，只确认这次提交的快照。
          setBaseline(canonicalize(sentBody));
          setSelectedId(saved.id);
          setCreating(false);
          setFailedBody("");
        }
      }
      setPending(null);
    } catch (failure) {
      if (!stillCurrent()) return;
      const rejected = failure instanceof AdminApiError && failure.status >= 400 && failure.status < 500 && failure.code !== "IDEMPOTENCY_KEY_REUSED";
      setPending(rejected ? null : command);
      if (rejected && failure.status === 409 && command.action === "save") setConflict(true);
      if (command.action === "save") setFailedBody(working);
      setError(rejected ? friendlyError(failure) : "操作结果尚未确认。请重试原请求，当前输入已保留。");
    } finally {
      operationActive.current = false;
      if (stillCurrent()) setBusy(null);
    }
  };

  const save = () => {
    if (!docType || !editable || (!dirty && !creating) || invalid || conflict || writeLocked || loading || (!creating && !selected)) return;
    const body = draftBody(docType, form);
    const command: WriteCommand = creating
      ? { action: "save", path: "/legal-documents/drafts", method: "POST", body: { ...body, docType }, key: newWriteKey() }
      : { action: "save", path: `/legal-documents/drafts/${encodeURIComponent(selected!.id)}`, method: "PUT", body: { ...body, expectedRevision: selected!.revision }, key: newWriteKey(), versionId: selected!.id };
    void execute(command);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty || invalid || conflict || writeLocked || loading || failedBody === working || deferred || target) return;
    const timer = setTimeout(() => saveRef.current(), 2000);
    return () => clearTimeout(timer);
  }, [dirty, working, invalid, conflict, writeLocked, loading, failedBody, deferred, target]);

  const openSubmit = (next: ReleaseTarget) => {
    if (!canSubmit || writeLocked) return;
    setTarget(next);
    setReason("");
    setNoticeKeys([]);
    setNoticeOptions([]);
    setNoticeOptionsFailed(false);
    setError(undefined);
  };

  useEffect(() => {
    if (!target || !("version" in target) || !canReadNotices) return;
    const controller = new AbortController();
    const load = async () => {
      const options: NoticeOption[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      try {
        do {
          const query = new URLSearchParams({ scope: "platform", limit: "5", ...(cursor ? { cursor } : {}) });
          const page: ResourcePage = await adminRequest<ResourcePage>(`/content/resources?${query}`, undefined, "GET", {}, controller.signal);
          options.push(...page.items.filter(row => NOTICE_DEFINITIONS.some(definition => definition.key === row.current.key) && row.metadata?.hasDraft)
            .map(row => ({ key: row.current.key, title: row.current.payload?.title ?? row.definition?.label ?? row.current.key })));
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("场景说明分页未完成");
          if (cursor) cursors.add(cursor);
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) setNoticeOptions(options);
      } catch {
        if (!controller.signal.aborted) setNoticeOptionsFailed(true);
      }
    };
    void load();
    return () => controller.abort();
  }, [target, canReadNotices]);

  const submit = async () => {
    if (!canSubmit || !target || reason.trim().length < 3 || writeLocked || operationActive.current) return;
    operationActive.current = true;
    setPreparing(true);
    setError(undefined);
    try {
      let items: SubmitItem[];
      if ("notice" in target) items = [await noticeItem(target.notice)];
      else {
        const version = target.version;
        items = [legalItem(version, records.current?.find(row => row.docType === version.docType))];
        for (const type of PLATFORM_TYPES) {
          if (type === version.docType || records.current?.some(row => row.docType === type)) continue;
          const draft = records.versions.find(row => row.docType === type && supportsDraft(row));
          if (!draft) throw new Error(`首次生效需要同时发布平台服务协议与用户隐私政策。请先保存${DOC_LABELS[type]}的草稿。`);
          items.push(legalItem(draft));
        }
        items.push(...await Promise.all(noticeKeys.map(async key => noticeItem(await adminRequest<ResourceDetail>(resourcePath(key))))));
      }
      operationActive.current = false;
      await execute({
        action: "submit", path: "/legal-documents/fixed-document-submissions", method: "POST",
        body: { items, reason: reason.trim() }, key: newWriteKey(),
      });
    } catch (failure) {
      setError(failure instanceof AdminApiError ? friendlyError(failure) : failure instanceof Error ? failure.message : friendlyError(failure));
    } finally {
      operationActive.current = false;
      setPreparing(false);
    }
  };

  const openApproval = (id: string) => {
    const path = `/approvals/${encodeURIComponent(id)}`;
    return canOpenApproval ? <Button type="button" size="sm" variant="secondary" disabled={writeLocked} onClick={() => guard(() => {
      if (onOpenPath) onOpenPath(path);
      else window.location.assign(path);
    })}>查看审批</Button> : null;
  };

  const history = docVersions.filter(version => versionLabel(version, current) === "历史版本");
  const pinnedVersions = [
    ...(current ? [current] : []),
    ...docVersions.filter(version => version.id !== current?.id && !history.includes(version)),
  ];
  const versionRow = (version: LegalVersion) => <button key={version.id} type="button" className="fixed-doc-nav-item fixed-doc-version"
    aria-pressed={selectedId === version.id} disabled={loading || writeLocked} onClick={() => {
      if (selectedId !== version.id) guard(() => select(version, mode === "compare" && version.id !== current?.id ? "compare" : undefined));
    }}>
    <span>{versionLabel(version, current)}</span>
    <time dateTime={version.effectiveAt ?? version.createdAt}>{version.effectiveAt ? "生效" : "创建"} · {formatBeijingDateTime(version.effectiveAt ?? version.createdAt)}</time>
  </button>;
  const preview = editable && (dirty || creating) ? { title: form.title, body: plainBody,
    bodyFormat: docType === "EARLY_SETTLEMENT" ? "text" as const : "plate" as const, bodyDocument: docType === "EARLY_SETTLEMENT" ? null : form.document } : selected;
  const validSubmit = selectedDraft && !dirty && !conflict && !invalid && publishReady && canSubmit;
  const noticeDefinition = NOTICE_DEFINITIONS.find(definition => definition.key === noticeKey);
  const title = docType ? (editable ? DOC_LABELS[docType] : selected?.title || DOC_LABELS[docType]) : noticeDefinition?.label ?? "页面说明";
  const savingLabel = pending?.action === "save" ? "failed" : conflict ? "conflict" : busy === "save" ? "saving" : dirty
    ? failedBody === working ? "failed" : "dirty" : selectedDraft ? "saved" : "idle";

  return <section className="fixed-doc-workbench" aria-label="协议条款" data-saving={busy === "save" || undefined}>
    <aside className="fixed-doc-sidebar">
      <nav aria-label="协议条款目录">
        <div className="fixed-doc-nav-group">
          <h3>协议与告知</h3>
          {DOC_TYPES.map(type => <button key={type} type="button" className="fixed-doc-nav-item"
            aria-pressed={section === type} disabled={loading || writeLocked} onClick={() => openSection(type)}>
            <FileText size={16} aria-hidden="true" /> {DOC_LABELS[type]}
          </button>)}
        </div>
        {canReadNotices ? <div className="fixed-doc-nav-group">
          <h3>页面说明</h3>
          {NOTICE_GROUPS.map(group => <div key={group.group} className="fixed-doc-nav-subgroup">
            <h4>{group.label}</h4>
            {NOTICE_DEFINITIONS.filter(definition => definition.group === group.group).map(definition => <button
              key={definition.key} type="button" className="fixed-doc-nav-item"
              aria-pressed={section === "notices" && noticeKey === definition.key} disabled={loading || writeLocked}
              onClick={() => openSection("notices", definition.key)}>
              <FileText size={16} aria-hidden="true" />
              <span>{definition.label}</span>
            </button>)}
          </div>)}
        </div> : null}
      </nav>
      {docType && docVersions.length ? <div className="fixed-doc-versions" aria-label="版本">
        <h3>版本</h3>
        {pinnedVersions.map(versionRow)}
        {history.length ? <details open={history.some(version => version.id === selectedId) || undefined}>
          <summary>历史版本</summary>{history.map(versionRow)}
        </details> : null}
      </div> : null}
    </aside>

    <div className="fixed-doc-main">
      <header className="fixed-doc-header">
        <div><h2>{title}</h2>
          {docType ? <p>{creating ? "新草稿" : editable && mode === "edit" ? "正在编辑草稿"
            : current && selected?.id === current.id ? `当前生效 · ${formatBeijingDateTime(current.effectiveAt)}（北京时间）`
              : selected ? `正在查看${selectedLabel}` : "暂无可查看的版本"}</p>
            : null}
        </div>
        <div className="fixed-doc-actions">
          {docType ? <Button type="button" size="sm" variant="ghost" disabled={loading || writeLocked}
            onClick={() => guard(() => void read())}><RefreshCw size={14} aria-hidden="true" />重新读取</Button> : null}
          {editable ? <Button type="button" size="sm" variant={canSubmit ? "secondary" : "default"} disabled={(!dirty && !creating) || loading || writeLocked || conflict || Boolean(invalid)}
            onClick={save}><Save size={14} aria-hidden="true" />保存草稿</Button> : null}
          {selectedDraft && canSubmit ? <Button type="button" size="sm" disabled={!validSubmit || writeLocked || loading}
            onClick={() => openSubmit({ version: selectedDraft })}><Send size={14} aria-hidden="true" />提交发布审批</Button> : null}
          {docType && !creating && !selectedDraft && canEdit ? <Button type="button" size="sm" disabled={loading || writeLocked}
            onClick={startDraft}><Plus size={14} aria-hidden="true" />{latestDraft ? "继续编辑草稿" : "起草新版"}</Button> : null}
        </div>
        {editable ? <div className="fixed-doc-save-slot">
          {creating && savingLabel === "idle" ? <span className="text-sm text-muted-foreground" role="status">草稿尚未保存</span>
            : <ContentSaveStatus phase={savingLabel} savedAt={null} message="草稿尚未保存" />}
        </div> : null}
      </header>

      {loadError ? <StatusMessage error={loadError} /> : null}
      {!target && error ? <StatusMessage error={error} /> : null}
      {!target && pending ? <Button type="button" size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void execute(pending)}>重试原请求</Button> : null}
      {submitted ? <div className="fixed-doc-receipt"><StatusMessage success="已提交固定文书发布审批。" />{openApproval(submitted)}</div> : null}
      {selected?.status === "PENDING" ? <div className="fixed-doc-receipt">
        <Badge variant="info">已提交审批</Badge>{selected.approvalRequestId && selected.approvalRequestId !== submitted ? openApproval(selected.approvalRequestId) : null}
        {canReturn ? <Button type="button" size="sm" variant="secondary" loading={busy === "return"} disabled={writeLocked} onClick={() => void execute({
          action: "return", path: `/legal-documents/drafts/${encodeURIComponent(selected.id)}/return`, method: "POST", body: {}, key: newWriteKey(), versionId: selected.id,
        })}><Undo2 size={14} aria-hidden="true" />退回草稿</Button> : null}
        <p className="text-sm text-muted-foreground">驳回或撤回后可退回草稿。</p>
      </div> : null}

      {section === "notices" && canReadNotices ? <>
        {canSubmit && !loading && !loadError && !bothPlatformLive ? <p className="text-sm text-muted-foreground">
          平台服务协议与用户隐私政策首次生效后，可以单独提交场景说明。
        </p> : null}
        <ContentResourcesTab key={noticeKey} group="notices" openResource={noticeKey} snapshot={snapshot} games={NO_GAMES} refreshNonce={refreshNonce + noticesRefresh}
          onDirtyChange={setNoticeDirty} onWriteLockChange={setNoticeLocked}
          noticeApprovalReady={bothPlatformLive && !noticeDirty && !writeLocked && !loading && !loadError}
          onSubmitNotice={canSubmit ? detail => openSubmit({ notice: detail }) : undefined} />
      </> : !docType ? null : !selected && !creating ? loading ? <div className="fixed-doc-body space-y-4" role="status" aria-label="读取文书">
        <Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" />
      </div> : !loadError ? <p className="fixed-doc-body text-sm text-muted-foreground">{canEdit ? "此文书暂无版本，可以起草新版。" : "此文书暂无可查看的版本。"}</p> : null
      : <Tabs value={mode} onValueChange={value => {
        if (value === "edit" || value === "preview" || value === "compare") setMode(value);
      }} className="fixed-doc-tabs">
        <TabsList aria-label="文书视图">
          {editable ? <TabsTrigger value="edit" disabled={preparing || busy === "submit"}>编辑</TabsTrigger> : null}
          {!creating ? <TabsTrigger value="compare">版本对比</TabsTrigger> : null}
          <TabsTrigger value="preview">用户端预览</TabsTrigger>
        </TabsList>
        {editable ? <TabsContent value="edit"><div className="fixed-doc-body fixed-doc-form" inert={loading || busy === "submit" || preparing}>
          <Field label="标题"><Input value={form.title} maxLength={160} autoFocus={creating} onChange={event => setForm(previous => ({ ...previous, title: event.target.value }))} /></Field>
          {docType === "EARLY_SETTLEMENT" ? <Field label="正文" hint="按纯文本保存。提前结算时，用户看到的是随订单留存的正文。"><Textarea rows={12} value={form.body} onChange={event => setForm(previous => ({ ...previous, body: event.target.value }))} /></Field>
            : <Suspense fallback={<div role="status" aria-label="编辑器加载中"><Skeleton className="h-32 w-full" /></div>}>
              <PlateEditor key={editorGeneration} preset="legal" canvas value={form.document.value} onChange={document => setForm(previous => ({ ...previous, document }))} />
            </Suspense>}
          {invalid && dirty ? <p className="text-sm text-muted-foreground">{invalid}</p> : null}
          {dirty && !invalid && !publishReady ? <p className="text-sm text-muted-foreground">提交审批前请处理排版校验提示。</p> : null}
          {creating ? <Button type="button" size="sm" variant="ghost" disabled={writeLocked} onClick={() => guard(() => select(current))}>取消新建</Button> : null}
        </div></TabsContent> : null}
        <TabsContent value="preview"><div className="fixed-doc-body">
          {preview ? <>{editable && preview.title !== title ? <h3>{preview.title}</h3> : null}<UserPreview version={preview} /></> : null}
        </div></TabsContent>
        {!creating ? <TabsContent value="compare"><div className="fixed-doc-compare">
          {dirty ? <p className="text-sm text-muted-foreground">请保存草稿后再比较。</p>
            : !canCompare ? <p className="text-sm text-muted-foreground">在左侧选择草稿、审批稿或其他版本，与当前生效版本对比。</p>
              : diffError ? <div className="space-y-2"><StatusMessage error={diffError} />
                <Button type="button" size="sm" variant="secondary" onClick={() => setDiffAttempt(value => value + 1)}>重试比较</Button></div>
                : diff && diff.draft.id === compareId ? <>
                  <p className="fixed-doc-compare-basis">{diff.current ? "以当前生效版本为基准，对比正文文字。排版可在各版本的用户端预览查看。" : "暂无生效版本，显示所选版本的正文。"}</p>
                  <DiffBlocks key={compareId} blocks={diff.blocks} emptyText="正文文字无变化。"
                    beforeLabel={diff.current ? "当前生效" : "暂无生效版本"} afterLabel={selectedLabel} />
                </>
                  : <div role="status" aria-label="读取版本差异"><Skeleton className="h-24 w-full" /></div>}
        </div></TabsContent> : null}
      </Tabs>}
    </div>

    <Dialog open={Boolean(deferred)} onOpenChange={open => { if (!open) setDeferred(null); }}>
      <DialogContent role="alertdialog">
        <DialogTitle>放弃未保存的修改？</DialogTitle>
        <DialogDescription>继续后将离开当前内容。你可以返回编辑，先保存草稿。</DialogDescription>
        <DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setDeferred(null)}>继续编辑</Button>
          <Button type="button" variant="danger" onClick={() => { const action = deferred; setDeferred(null); action?.(); }}>放弃修改并继续</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(target)} onOpenChange={open => { if (!open && !writeLocked) setTarget(null); }}>
      <DialogContent>
        <DialogTitle>提交固定文书发布审批</DialogTitle>
        <DialogDescription>批准后生效。平台服务协议与用户隐私政策首次生效时会一并提交。</DialogDescription>
        {error ? <StatusMessage error={error} /> : null}
        <Field label="发布理由（3 到 500 字）"><Textarea rows={4} value={reason} maxLength={500}
          disabled={writeLocked} onChange={event => setReason(event.target.value)} /></Field>
        {target && "version" in target && noticeOptions.length ? <div className="space-y-2">
          <p className="text-sm font-medium">同时发布的场景说明（可选）</p>
          {noticeOptions.map(notice => <label key={notice.key} className="flex items-center gap-2 text-sm">
            <Checkbox aria-label={notice.title} checked={noticeKeys.includes(notice.key)} disabled={writeLocked} onCheckedChange={checked =>
              setNoticeKeys(previous => checked === true ? [...previous, notice.key] : previous.filter(key => key !== notice.key))} />
            {notice.title}
          </label>)}
        </div> : null}
        {noticeOptionsFailed ? <p className="text-sm text-muted-foreground">场景说明草稿暂未读取，可以单独提交本文书。</p> : null}
        <DialogFooter><Button type="button" variant="secondary" disabled={writeLocked} onClick={() => setTarget(null)}>取消</Button>
          {pending ? <Button type="button" disabled={Boolean(busy)} onClick={() => void execute(pending)}>重试原请求</Button>
            : <Button type="button" disabled={writeLocked || reason.trim().length < 3} onClick={() => void submit()}>
              {preparing ? "提交中…" : "提交审批"}
            </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

function legalItem(version: LegalVersion, current?: LegalVersion): SubmitItem {
  return { kind: version.docType, key: version.docType, draftVersionId: version.id, digest: version.digest, baseVersionId: current?.id ?? null };
}

function newWriteKey(): string {
  return `idem_${crypto.randomUUID().replaceAll("-", "")}`;
}
