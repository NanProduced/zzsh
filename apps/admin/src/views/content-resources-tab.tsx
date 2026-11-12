import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, FileText, ImageIcon, ImageOff, Plus, RefreshCw, Search } from "lucide-react";
import { adminRequest, friendlyError, hasPermission, type ContentGame, type SessionSnapshot } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { Input } from "../components/ui/input";
import { Field } from "../components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ContentSelect } from "./content-resource-fields";
import { RESOURCE_KIND_LABEL, resourceCategoryLabel, resourcePath, resourceStateInfo, type ContentOperation, type ResourceDetail, type ResourceListItem, type ResourcePage } from "./content-resources-model";
import { ContentImage, contentMediaUrl } from "./content-media-upload";
import { useContentResourceWrite } from "./content-resource-write";
import { emptyPlateDocument } from "./content-plate";
import "./content-management.css";

const DocumentEditor = lazy(() => import("./content-resource-editor").then(module => ({ default: module.ContentResourceEditor })));
const MediaEditor = lazy(() => import("./content-media-editor").then(module => ({ default: module.ContentMediaEditor })));
const FooterEditor = lazy(() => import("./content-footer-editor").then(module => ({ default: module.ContentFooterEditor })));
const groupLabels = { site: "首页与全站", market: "账号市场", publish: "上架页面", rental: "租号页面", help: "帮助中心" };

async function withEditorSource(detail: ResourceDetail): Promise<ResourceDetail> {
  if (detail.draft?.payload || detail.published?.payload || detail.baseline || detail.current.payload) return detail;
  const latest = detail.versions[0];
  if (!latest) throw new Error("内容正文缺失，请重新读取。");
  const source = await adminRequest<NonNullable<ResourceDetail["editorSource"]>>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(latest.id)}`);
  if (source.version.id !== latest.id || source.version.revision !== latest.revision || !source.version.payload || !Array.isArray(source.media)) throw new Error("历史版本读取不完整，请重新读取。");
  return { ...detail, editorSource: source };
}

export function ContentResourcesTab({ group, gameOnly = false, snapshot, games, refreshNonce, onDirtyChange, onWriteLockChange, openResource, noticeApprovalReady, onSubmitNotice, onOpenMedia }: {
  group: "rules" | "pages" | "notices"; gameOnly?: boolean; snapshot: Extract<SessionSnapshot, { authenticated: true }>; games: ContentGame[]; refreshNonce: number; onDirtyChange: (dirty: boolean) => void; onWriteLockChange?: (locked: boolean) => void;
  /** 帮助树和页面说明入口：挂载后自动打开该资源 key。 */
  openResource?: string;
  noticeApprovalReady?: boolean;
  onSubmitNotice?: (detail: ResourceDetail) => void;
  onOpenMedia?: () => void;
}) {
  const platform = hasPermission(snapshot, "content.platform.read"), game = hasPermission(snapshot, "content.read");
  const [scope, setScope] = useState<"platform" | "game">(gameOnly ? "game" : platform || group === "notices" ? "platform" : "game"), [gameId, setGameId] = useState("");
  const [items, setItems] = useState<ResourceListItem[]>([]), [detail, setDetail] = useState<ResourceDetail | null>(null), [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "published" | "draft" | "builtin" | "withdrawn">("all");
  const [loading, setLoading] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState<string>(), [newTitle, setNewTitle] = useState("");
  const [listError, setListError] = useState<string>(), [listComplete, setListComplete] = useState(false);
  const [createOpen, setCreateOpen] = useState(false), [flowBusy, setFlowBusy] = useState(false), [editorGeneration, setEditorGeneration] = useState(0);
  const [deferred, setDeferred] = useState<(() => void) | null>(null);
  const sequence = useRef(0), detailSequence = useRef(0), dirtyRef = useRef(false), flowSequence = useRef(0), flowRef = useRef<number | null>(null), selection = useRef<string | null>(null), alive = useRef(true);
  const writer = useContentResourceWrite(snapshot.adminUserId, snapshot.session.id);
  const canEdit = hasPermission(snapshot, scope === "platform" ? "content.platform.edit" : "content.edit");
  const payload = detail?.draft?.payload ?? detail?.published?.payload ?? detail?.baseline ?? detail?.current.payload ?? detail?.editorSource?.version.payload;
  const canPublish = group !== "notices" && payload?.kind !== "notice" && detail?.definition?.kind !== "notice"
    && hasPermission(snapshot, scope === "platform" ? "content.platform.publish" : "content.publish");
  const selectedGame = gameId || games[0]?.id || "", locked = writer.locked || flowBusy;
  const directNotice = group === "notices" && Boolean(openResource);
  const requestGameId = scope === "game" ? selectedGame : "";
  const guard = (action: () => void) => { if (writer.locked || flowRef.current) return; if (dirtyRef.current) setDeferred(() => action); else action(); };
  const dirty = useCallback((value: boolean) => { dirtyRef.current = value; onDirtyChange(value); }, [onDirtyChange]);
  const load = useCallback(async () => {
    const seq = ++sequence.current; setLoading(true); setError(undefined); setListError(undefined); setListComplete(false);
    if (scope === "game" && !requestGameId) { setItems([]); setLoading(false); return; }
    try {
      let cursor: string | null = null; const all: ResourceListItem[] = [], seen = new Set<string>();
      do {
        const query = new URLSearchParams({ scope, limit: "5", ...(scope === "game" ? { gameId: requestGameId } : { includeFooter: "1" }), ...(cursor ? { cursor } : {}) });
        const page: ResourcePage = await adminRequest(`/content/resources?${query}`);
        if (seq !== sequence.current || !alive.current) return;
        all.push(...page.items); cursor = page.nextCursor;
        if (alive.current && seq === sequence.current) setItems([...all]);
        if (cursor && seen.has(cursor)) throw new Error("内容分页未能完成，请重试。");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (seq === sequence.current && alive.current) setListComplete(true);
    } catch (failure) { if (seq === sequence.current && alive.current) setListError(friendlyError(failure)); }
    finally { if (seq === sequence.current && alive.current) setLoading(false); }
  }, [scope, requestGameId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current; ++detailSequence.current; }; }, []);
  useEffect(() => { setItems([]); setDetail(null); selection.current = null; ++detailSequence.current; if (!directNotice) void load(); return () => { ++sequence.current; ++detailSequence.current; }; }, [load, directNotice]);
  const lastRefresh = useRef(refreshNonce);
  useEffect(() => {
    if (lastRefresh.current === refreshNonce) return;
    lastRefresh.current = refreshNonce;
    if (!directNotice) void load();
    if (directNotice && openResource && !dirtyRef.current && !locked) void open(openResource, true);
  }, [refreshNonce, load]);
  useEffect(() => { onDirtyChange(dirtyRef.current || locked); }, [locked, onDirtyChange]);
  useEffect(() => { onWriteLockChange?.(locked || (directNotice && opening)); }, [locked, directNotice, opening, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const open = async (key: string, preserveDirty = false) => {
    const seq = ++detailSequence.current; selection.current = key; setOpening(true); setError(undefined); writer.clearConflict();
    try {
      const value = await withEditorSource(await adminRequest<ResourceDetail>(resourcePath(key)));
      if (seq === detailSequence.current && alive.current) {
        if (preserveDirty && dirtyRef.current) { setError("发布状态已变化，请先复制未保存的内容，再重新读取。"); return; }
        setDetail(value); setEditorGeneration(value => value + 1);
      }
    }
    catch (failure) { if (seq === detailSequence.current && alive.current) setError(friendlyError(failure)); }
    finally { if (seq === detailSequence.current && alive.current) setOpening(false); }
  };
  // 深链打开：只在 key 变化时触发一次。
  const lastOpenResource = useRef<string | null>(null);
  useEffect(() => {
    if (!openResource || (group !== "rules" && group !== "notices") || lastOpenResource.current === openResource) return;
    lastOpenResource.current = openResource;
    void open(openResource);
    return () => { lastOpenResource.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openResource, group]);
  const accept = async (value: ResourceDetail | undefined, key: string, seq: number, reset = true) => {
    if (!value || !alive.current || seq !== detailSequence.current || selection.current !== key || value.key !== key) return;
    let editable: ResourceDetail;
    try { editable = await withEditorSource(value); }
    catch (failure) {
      if (!alive.current || seq !== detailSequence.current || selection.current !== key) return;
      setDetail(null); selection.current = null; dirty(false);
      if (!directNotice) await load();
      if (alive.current && seq === detailSequence.current) setError(`操作已记录，但正文读取失败：${friendlyError(failure)} 请重新打开内容。`);
      return;
    }
    if (!alive.current || seq !== detailSequence.current || selection.current !== key) return;
    setDetail(editable);
    if (reset) { setEditorGeneration(current => current + 1); dirtyRef.current = false; onDirtyChange(false); }
    if (!directNotice) await load();
  };
  const write = async (operation: ContentOperation, body: Record<string, unknown>) => {
    const publishing = operation === "content.resource.publish" || operation === "content.resource.withdraw";
    if (!detail || locked || flowRef.current || (publishing ? !canPublish : !canEdit)) return;
    const key = detail.key, seq = detailSequence.current; let current = detail;
    const flow = ++flowSequence.current; flowRef.current = flow; setFlowBusy(true);
    try {
      if (operation === "content.resource.draft.save" || operation === "content.resource.media-draft.save") {
        if (!current.draft) {
          const created = await writer.write(key, "content.resource.draft.create", {});
          if (!created || !alive.current || seq !== detailSequence.current || selection.current !== key) return;
          current = created;
          await accept(created, key, seq, false);
        }
        if (!current.draft || !current.item) return;
        body = { ...body, versionId: current.draft.id, expectedRevision: current.item.revision };
      }
      // 文档草稿保存不重挂载编辑器（缺陷 2：保存闪烁）：保留 DocumentEditor 实例与 PlateEditor
      // contenteditable 节点身份，由编辑器就地推进基线。其它操作（建草稿/发布/撤回/恢复）仍重置。
      const keepEditorMounted = operation === "content.resource.draft.save";
      await accept(await writer.write(key, operation, body), key, seq, !keepEditorMounted);
    } finally { if (flowRef.current === flow) { flowRef.current = null; if (alive.current) setFlowBusy(false); } }
  };
  const recover = async () => {
    const original = writer.pending, seq = detailSequence.current;
    const result = await writer.recover();
    if (result && original) {
      if (selection.current === original.resourceId) await accept(result, original.resourceId, seq, original.operation !== "content.resource.draft.create");
      else await load();
    }
  };
  const create = async () => {
    if (!canEdit || locked || flowRef.current || !newTitle.trim()) return;
    const slug = `guide-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const payload = { kind: "guide", id: slug, slug, title: newTitle.trim(), summary: "", category: "rental", audience: ["all"], keywords: [], related: [], updatedAt: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), format: "plate", schemaVersion: 1, document: emptyPlateDocument("help"), mediaIds: [] };
    const seq = ++detailSequence.current, key = `guide:${slug}`; selection.current = key;
    const flow = ++flowSequence.current; flowRef.current = flow; setFlowBusy(true);
    try { await accept(await writer.write(key, "content.resource.draft.create", { payload, ...(scope === "game" ? { gameId: selectedGame } : {}) }), key, seq); setCreateOpen(false); setNewTitle(""); }
    finally { if (flowRef.current === flow) { flowRef.current = null; if (alive.current) setFlowBusy(false); } }
  };
  const searched = items.filter(row => {
    const kind = row.current.payload?.kind ?? row.definition?.kind ?? (row.current.key.startsWith("guide:") ? "guide" : null);
    const inGroup = group === "notices" ? kind === "notice" : group === "rules" ? kind === "guide" : kind !== "guide" && kind !== "notice";
    return inGroup && `${row.definition?.label ?? ""} ${row.current.payload?.title ?? ""} ${row.metadata?.title ?? ""} ${row.current.key} ${row.definition?.locations.join(" ") ?? ""} ${resourceCategoryLabel(row.current.payload)}`.toLowerCase().includes(search.toLowerCase());
  });
  const stateMatches = (row: ResourceListItem, value: typeof stateFilter) => value === "all"
    || (value === "draft" ? Boolean(row.metadata?.hasDraft)
      : value === "published" ? row.current.state === "available" && row.current.source === "MANAGED"
      : value === "builtin" ? row.current.state === "available" && row.current.source !== "MANAGED"
      : row.current.state === "withdrawn");
  const visible = searched.filter(row => stateMatches(row, stateFilter));
  const stateChips = ([["all", "全部"], ["published", "已发布"], ["draft", "有草稿"], ["builtin", "内置内容"], ["withdrawn", "已撤回"]] as const).map(([value, label]) => ({ value, label, count: value === "all" ? searched.length : searched.filter(row => stateMatches(row, value)).length }));
  const listMeta = loading ? `读取中…（${items.length} 项）` : listComplete ? `共 ${searched.length} 项 · 已全部加载` : `读取未完成 · 已读 ${items.length} 项`;
  const groups = group === "pages" ? [...new Set(visible.map(row => row.definition?.group ?? "site"))] : ["help"];
  const relatedOptions = items.flatMap(row => row.current.payload?.kind === "guide" ? [{ slug: row.current.payload.slug, title: row.metadata?.title ?? row.current.payload.title }] : []);
  const isDocument = payload?.kind === "guide" || payload?.kind === "notice";
  return <div className="content-management space-y-4">
    {directNotice && opening ? <p role="status" className="text-sm text-muted-foreground">{detail ? "正在重新读取页面说明…" : "正在读取页面说明…"}</p> : null}
    <div inert={directNotice && opening || undefined} className="space-y-4">
    {!detail && ((writer.pending && !writer.busy) || writer.blocked) ? <section className="section-panel space-y-3"><h3 className="text-sm font-semibold">有待核对的内容操作</h3><p className="text-sm text-muted-foreground">原请求保留期间暂停内容写入。请先核对结果。</p><Button type="button" variant="secondary" loading={writer.busy} disabled={writer.blocked} onClick={() => void recover()}>核对原操作结果</Button></section> : null}
    {!detail ? <StatusMessage error={writer.error || error} success={writer.success} /> : null}
    {directNotice && !detail && error && openResource ? <Button type="button" size="sm" variant="secondary" disabled={opening} onClick={() => void open(openResource)}>重试读取内容</Button> : null}
    {(!detail || !isDocument) && !directNotice ? <section className="section-panel space-y-5">
      {group !== "notices" ?<div className="content-heading"><div><h3 className="text-base font-semibold">{gameOnly ? "游戏手册" : group === "rules" ? "规则与帮助手册" : "用户站展示"}</h3><p className="mt-1 text-sm text-muted-foreground">{gameOnly ? "按游戏维护攻略与说明。发布后，用户可在帮助中心的对应分类和搜索结果中找到手册。" : group === "rules" ? "编辑帮助与说明；保存不改变线上。" : "按页面更换轮播、海报和二维码，也可管理网站页脚。"}</p></div><div className="content-heading-meta">{!canEdit ? <Badge variant="unknown">只读</Badge> : null}{group === "rules" && canEdit ? <Button type="button" size="sm" disabled={locked || (scope === "game" && !selectedGame)} onClick={() => setCreateOpen(true)}><Plus size={14} aria-hidden="true" />新建手册</Button> : null}</div></div> : null}
      {group === "pages" ? <div className="content-media-guide">
        <p className="text-sm text-muted-foreground">{canEdit ? "选中要更换的位置，再从图片素材选择，或直接上传新图。" : "图片需审核通过并公开，才可用于用户站。"}</p>
        {onOpenMedia ? <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onOpenMedia}>去图片素材<ArrowRight size={14} aria-hidden="true" /></Button> : null}
      </div> : null}
      <div className="content-toolbar">
        <div className="content-search"><Search size={15} aria-hidden="true" /><Input aria-label={group === "notices" ? "搜索页面说明" : group === "rules" ? "搜索标题、分类或使用位置" : "搜索页面或位置"} value={search} placeholder={group === "notices" ? "搜索标题或使用位置" : group === "rules" ? "搜索标题、分类或位置" : "搜索轮播、海报、二维码"} onChange={event => setSearch(event.target.value)} /></div>
        {group === "rules" && game && !gameOnly ? <label className="content-inline-field"><span>范围</span><ContentSelect ariaLabel="内容范围" value={scope} disabled={locked} onChange={next => guard(() => setScope(next as "platform" | "game"))} options={[...(platform ? [{ value: "platform", label: "平台内容" }] : []), { value: "game", label: "游戏手册" }]} className="min-w-36" /></label> : null}
        {scope === "game" ? <label className="content-inline-field"><span>游戏</span><ContentSelect ariaLabel="游戏" disabled={locked} value={selectedGame} onChange={next => guard(() => setGameId(next))} options={games.length ? games.map(value => ({ value: value.id, label: value.name })) : [{ value: "", label: "没有可用游戏范围" }]} className="min-w-36" /></label> : null}
        <Button type="button" size="sm" variant="ghost" disabled={loading || locked} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
        <div className="content-state-filter" role="group" aria-label="按状态筛选">{stateChips.map(chip => <Button key={chip.value} type="button" size="sm" variant={stateFilter === chip.value ? "secondary" : "ghost"} aria-pressed={stateFilter === chip.value} disabled={loading} onClick={() => setStateFilter(chip.value)}>{chip.label}<span className="content-state-count">{chip.count}</span></Button>)}</div>
      </div>
      <div className={group === "pages" && !loading && !listError ? "sr-only" : "content-list-meta"} role="status" aria-live="polite"><span>{listMeta}</span></div>
      {gameOnly && !selectedGame ? <p className="text-sm text-muted-foreground">暂无启用的游戏。启用游戏后，可在这里为它新建手册。</p> : null}
      {listError ? <div><StatusMessage error={listError} /><Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>重试读取内容</Button></div> : null}
      {loading || opening ? <div className="space-y-3 py-3" role="status" aria-label={opening ? "读取内容详情" : "读取内容列表"}>{[1, 2, 3].map(value => <div key={value} className="h-12 rounded-lg bg-muted/50" />)}</div> : null}
      {!loading && !listError && listComplete && !visible.length ? <div className="py-10 text-center"><FileText size={24} aria-hidden="true" className="mx-auto text-muted-foreground" /><p className="mt-3 text-sm font-medium">{search || stateFilter !== "all" ? "没有匹配的内容" : "当前范围没有内容"}</p><p className="mt-1 text-sm text-muted-foreground">{search || stateFilter !== "all" ? "调整搜索词或状态筛选后再试。" : group === "rules" && canEdit ? "可以新建一篇帮助手册。" : "有可维护的位置后会显示在这里。"}</p></div> : null}
      {!loading ? groups.map(pageGroup => <div className="content-page-group" key={pageGroup}>{group === "pages" ? <h4 className="mb-2 text-sm font-semibold">{groupLabels[pageGroup as keyof typeof groupLabels] ?? pageGroup}</h4> : null}<div className="content-resource-list">{visible.filter(row => group !== "pages" || (row.definition?.group ?? "site") === pageGroup).map(row => {
        const kind = row.current.payload?.kind ?? row.definition?.kind ?? "guide", state = resourceStateInfo(row), image = row.current.media.find(value => value.url);
        const title = (group === "pages" ? row.definition?.label : undefined) || row.current.payload?.title || row.metadata?.title || row.definition?.label || "未命名内容";
        const draftTitle = row.metadata?.hasDraft && row.metadata.title && row.metadata.title !== title ? row.metadata.title : null;
        const caption = group === "pages" ? row.definition?.locations.join(" · ") : [row.definition?.locations.join(" · ") || "帮助中心", RESOURCE_KIND_LABEL[kind], resourceCategoryLabel(row.current.payload)].filter(Boolean).join(" · ");
        return <div className="content-resource-row" key={row.current.key}>
          <div className="content-resource-main">{group === "pages" ? <div className="content-resource-thumb content-place-thumb">{image
            ? <ContentImage src={contentMediaUrl(image.id)} alt={`${title}的当前图片`} lazy />
            : row.current.media.length ? <ImageOff size={17} aria-label="图片无法显示" /> : kind === "footer" ? <FileText size={17} aria-hidden="true" /> : <ImageIcon size={17} aria-hidden="true" />}</div>
            : <span className="content-resource-icon"><BookOpen size={17} aria-hidden="true" /></span>}<div className="min-w-0"><p className="content-resource-title">{title}</p><p className="content-resource-caption">{caption}</p>{group !== "pages" && draftTitle ? <p className="content-resource-draft">草稿标题：{draftTitle}</p> : null}</div></div>
          <div className="content-resource-state"><Badge variant={state.tone}>{state.label}</Badge>{group !== "pages" && state.detail ? <p className="content-resource-fact">{state.detail}</p> : null}</div>
          <Button type="button" size="sm" variant="secondary" disabled={locked || opening} onClick={() => guard(() => void open(row.current.key))}>{!canEdit ? "查看" : group !== "pages" ? "编辑文档" : kind === "footer" ? "编辑页脚" : kind === "contact" ? "更换二维码" : "更换图片"}</Button>
        </div>;
      })}</div></div>) : null}
    </section> : null}
    {group === "notices" && detail?.draft?.payload?.kind === "notice" && onSubmitNotice ? <div className="flex flex-wrap items-center justify-end gap-3">
      <p className="text-sm text-muted-foreground">草稿保存后可提交协议条款发布审批。</p>
      <Button type="button" size="sm" disabled={!noticeApprovalReady || locked || opening || writer.conflict}
        onClick={() => onSubmitNotice(detail)}>提交发布审批</Button>
    </div> : null}
    {detail ? <Suspense fallback={<section className="section-panel py-12 text-sm text-muted-foreground" role="status">加载内容工作面…</section>}>{isDocument ? <DocumentEditor key={`${detail.key}:${editorGeneration}`} detail={detail} canEdit={canEdit} canPublish={canPublish} locked={locked} busy={writer.busy || flowBusy} pending={Boolean(writer.pending) || writer.blocked} operationError={writer.error || error} success={writer.success} conflict={writer.conflict} onReload={() => guard(() => void open(detail.key))} onRecover={() => void recover()} onWrite={write} canUpload={hasPermission(snapshot, "content.platform.edit")} canReview={hasPermission(snapshot, "content.platform.publish")} relatedOptions={relatedOptions} canBrowseMedia={platform} hideBackButton={directNotice} onClose={() => guard(() => { ++detailSequence.current; selection.current = null; setDetail(null); dirty(false); })} onDirtyChange={dirty} /> : payload?.kind === "footer" ? <FooterEditor key={`${detail.key}:${editorGeneration}`} detail={detail} canEdit={canEdit} canPublish={canPublish} locked={locked} busy={writer.busy || flowBusy} pending={Boolean(writer.pending) || writer.blocked} operationError={writer.error || error} success={writer.success} onRecover={() => void recover()} onWrite={write} canUpload={hasPermission(snapshot, "content.platform.edit")} canReview={hasPermission(snapshot, "content.platform.publish")} onClose={() => guard(() => { ++detailSequence.current; selection.current = null; setDetail(null); dirty(false); })} onDirtyChange={dirty} /> : <MediaEditor key={`${detail.key}:${editorGeneration}`} detail={detail} canEdit={canEdit} canPublish={canPublish} locked={locked} busy={writer.busy || flowBusy} pending={Boolean(writer.pending) || writer.blocked} operationError={writer.error || error} success={writer.success} onRecover={() => void recover()} onWrite={write} canUpload={hasPermission(snapshot, "content.platform.edit")} canReview={hasPermission(snapshot, "content.platform.publish")} onClose={() => guard(() => { ++detailSequence.current; selection.current = null; setDetail(null); dirty(false); })} onDirtyChange={dirty} />}</Suspense> : null}
    <Dialog open={Boolean(deferred)} onOpenChange={open => { if (!open) setDeferred(null); }}><DialogContent role="alertdialog"><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前修改还未保存，继续后将丢失。已经发送且结果待核对的请求不会被取消。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setDeferred(null)}>继续编辑</Button><Button type="button" variant="danger" onClick={() => { const action = deferred; setDeferred(null); dirty(false); action?.(); }}>放弃修改并继续</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogTitle>{gameOnly ? "新建游戏手册" : "新建帮助手册"}</DialogTitle><DialogDescription>{gameOnly ? "先为当前游戏创建草稿。发布后，文章会进入用户侧帮助中心。" : "先填写标题，随后编写正文。页面地址会自动生成并保持稳定。"}</DialogDescription><Field label="文档标题"><Input value={newTitle} onChange={event => setNewTitle(event.target.value)} maxLength={200} autoFocus /></Field><DialogFooter><Button type="button" variant="secondary" disabled={locked} onClick={() => setCreateOpen(false)}>取消</Button><Button type="button" disabled={locked || !newTitle.trim() || (scope === "game" && !selectedGame)} onClick={() => void create()}>创建手册</Button></DialogFooter></DialogContent></Dialog>
    </div>
  </div>;
}
type StorageStatus = { configured: boolean; readCheck: "NOT_RUN" | "NO_PUBLIC_SAMPLE" | "PASS" | "FAILED" };
export function ContentStoragePanel() {
  const [status, setStatus] = useState<StorageStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const check = async () => {
    setBusy(true); setStatus(null); setError(undefined);
    try { setStatus(await adminRequest<StorageStatus>("/content/storage/check")); }
    catch (failure) { setError(friendlyError(failure)); }
    finally { setBusy(false); }
  };
  const label = status && (status.configured ? {
    NOT_RUN: "未完成检查，请重试。", NO_PUBLIC_SAMPLE: "还没有公开图片可供检查。", PASS: "已确认一张公开图片可以读取。", FAILED: "公开图片读取失败，请联系维护人员。",
  }[status.readCheck] : "当前无法读取图片，请联系维护人员。");
  return <details className="content-picture-storage px-2 text-sm">
    <summary>图片打不开？</summary>
    <div className="mt-2 space-y-2">
      <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => void check()}>检查一张公开图片</Button>
      {label ? <p role="status">{label}</p> : null}
      <StatusMessage error={error} />
    </div>
  </details>;
}
