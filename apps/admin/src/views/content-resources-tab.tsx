import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, FileText, ImageOff, Plus, RefreshCw, Search } from "lucide-react";
import { type GuideResource } from "@zzsh/content";
import { adminRequest, friendlyError, hasPermission, type ContentGame, type SessionSnapshot } from "../api";
import { Badge } from "../components/ui/badge";
import { Button, StatusMessage } from "../components/ui-elements";
import { Input } from "../components/ui/input";
import { Field } from "../components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ContentSelect } from "./content-resource-fields";
import { RESOURCE_KIND_LABEL, resourceCategoryLabel, resourcePath, resourceRequirement, resourceStateInfo, type ContentOperation, type ResourceDetail, type ResourceListItem, type ResourcePage } from "./content-resources-model";
import { useContentResourceWrite } from "./content-resource-write";
import "./content-management.css";

const DocumentEditor = lazy(() => import("./content-resource-editor").then(module => ({ default: module.ContentResourceEditor })));
const MediaEditor = lazy(() => import("./content-media-editor").then(module => ({ default: module.ContentMediaEditor })));
const groupLabels = { site: "首页与全站", market: "账号市场", publish: "上架页面", rental: "租号页面", help: "帮助中心" };

async function withEditorSource(detail: ResourceDetail): Promise<ResourceDetail> {
  if (detail.draft?.payload || detail.published?.payload || detail.baseline || detail.current.payload) return detail;
  const latest = detail.versions[0];
  if (!latest) throw new Error("内容正文缺失，请重新读取。");
  const source = await adminRequest<NonNullable<ResourceDetail["editorSource"]>>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(latest.id)}`);
  if (source.version.id !== latest.id || source.version.revision !== latest.revision || !source.version.payload || !Array.isArray(source.media)) throw new Error("历史版本读取不完整，请重新读取。");
  return { ...detail, editorSource: source };
}

export function ContentResourcesTab({ group, snapshot, games, refreshNonce, onDirtyChange, onWriteLockChange }: {
  group: "rules" | "pages"; snapshot: Extract<SessionSnapshot, { authenticated: true }>; games: ContentGame[]; refreshNonce: number; onDirtyChange: (dirty: boolean) => void; onWriteLockChange?: (locked: boolean) => void;
}) {
  const platform = hasPermission(snapshot, "content.platform.read"), game = hasPermission(snapshot, "content.read");
  const [scope, setScope] = useState<"platform" | "game">(platform ? "platform" : "game"), [gameId, setGameId] = useState("");
  const [items, setItems] = useState<ResourceListItem[]>([]), [detail, setDetail] = useState<ResourceDetail | null>(null), [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "published" | "draft" | "builtin" | "withdrawn">("all");
  const [loading, setLoading] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState<string>(), [newTitle, setNewTitle] = useState("");
  const [listError, setListError] = useState<string>(), [listComplete, setListComplete] = useState(false);
  const [createOpen, setCreateOpen] = useState(false), [flowBusy, setFlowBusy] = useState(false), [editorGeneration, setEditorGeneration] = useState(0);
  const [deferred, setDeferred] = useState<(() => void) | null>(null);
  const sequence = useRef(0), detailSequence = useRef(0), dirtyRef = useRef(false), flowSequence = useRef(0), flowRef = useRef<number | null>(null), selection = useRef<string | null>(null), alive = useRef(true);
  const writer = useContentResourceWrite(snapshot.adminUserId, snapshot.session.id);
  const canEdit = hasPermission(snapshot, scope === "platform" ? "content.platform.edit" : "content.edit");
  const canPublish = hasPermission(snapshot, scope === "platform" ? "content.platform.publish" : "content.publish");
  const selectedGame = gameId || games[0]?.id || "", locked = writer.locked || flowBusy;
  const requestGameId = scope === "game" ? selectedGame : "";
  const guard = (action: () => void) => { if (writer.locked || flowRef.current) return; if (dirtyRef.current) setDeferred(() => action); else action(); };
  const dirty = useCallback((value: boolean) => { dirtyRef.current = value; onDirtyChange(value); }, [onDirtyChange]);
  const load = useCallback(async () => {
    const seq = ++sequence.current; setLoading(true); setError(undefined); setListError(undefined); setListComplete(false);
    if (scope === "game" && !requestGameId) { setItems([]); setLoading(false); return; }
    try {
      let cursor: string | null = null; const all: ResourceListItem[] = [], seen = new Set<string>();
      do {
        const query = new URLSearchParams({ scope, limit: "5", ...(scope === "game" ? { gameId: requestGameId } : {}), ...(cursor ? { cursor } : {}) });
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
  useEffect(() => { setItems([]); setDetail(null); selection.current = null; ++detailSequence.current; void load(); return () => { ++sequence.current; ++detailSequence.current; }; }, [load]);
  const lastRefresh = useRef(refreshNonce);
  useEffect(() => { if (lastRefresh.current !== refreshNonce) { lastRefresh.current = refreshNonce; void load(); } }, [refreshNonce, load]);
  useEffect(() => { onDirtyChange(dirtyRef.current || locked); }, [locked, onDirtyChange]);
  useEffect(() => { onWriteLockChange?.(locked); }, [locked, onWriteLockChange]);
  useEffect(() => () => onWriteLockChange?.(false), [onWriteLockChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const open = async (key: string) => {
    const seq = ++detailSequence.current; selection.current = key; setOpening(true); setError(undefined);
    try { const value = await withEditorSource(await adminRequest<ResourceDetail>(resourcePath(key))); if (seq === detailSequence.current && alive.current) { setDetail(value); setEditorGeneration(value => value + 1); } }
    catch (failure) { if (seq === detailSequence.current && alive.current) setError(friendlyError(failure)); }
    finally { if (seq === detailSequence.current && alive.current) setOpening(false); }
  };
  const accept = async (value: ResourceDetail | undefined, key: string, seq: number, reset = true) => {
    if (!value || !alive.current || seq !== detailSequence.current || selection.current !== key || value.key !== key) return;
    let editable: ResourceDetail;
    try { editable = await withEditorSource(value); }
    catch (failure) {
      if (!alive.current || seq !== detailSequence.current || selection.current !== key) return;
      setDetail(null); selection.current = null; dirty(false);
      await load();
      if (alive.current && seq === detailSequence.current) setError(`操作已记录，但正文读取失败：${friendlyError(failure)} 请重新打开内容。`);
      return;
    }
    if (!alive.current || seq !== detailSequence.current || selection.current !== key) return;
    setDetail(editable);
    if (reset) { setEditorGeneration(current => current + 1); dirtyRef.current = false; onDirtyChange(false); }
    await load();
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
      await accept(await writer.write(key, operation, body), key, seq);
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
    const payload: GuideResource = { kind: "guide", id: slug, slug, title: newTitle.trim(), summary: "", category: "rental", audience: ["all"], keywords: [], related: [], updatedAt: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), format: "markdown", schemaVersion: 1, markdown: "", mediaIds: [] };
    const seq = ++detailSequence.current, key = `guide:${slug}`; selection.current = key;
    const flow = ++flowSequence.current; flowRef.current = flow; setFlowBusy(true);
    try { await accept(await writer.write(key, "content.resource.draft.create", { payload, ...(scope === "game" ? { gameId: selectedGame } : {}) }), key, seq); setCreateOpen(false); setNewTitle(""); }
    finally { if (flowRef.current === flow) { flowRef.current = null; if (alive.current) setFlowBusy(false); } }
  };
  const searched = items.filter(row => {
    const kind = row.current.payload?.kind ?? row.definition?.kind ?? (row.current.key.startsWith("guide:") ? "guide" : null);
    return (group === "rules" ? kind === "guide" || kind === "notice" : kind !== "guide" && kind !== "notice") && `${row.definition?.label ?? ""} ${row.current.payload?.title ?? ""} ${row.metadata?.title ?? ""} ${row.current.key} ${row.definition?.locations.join(" ") ?? ""} ${resourceCategoryLabel(row.current.payload)}`.toLowerCase().includes(search.toLowerCase());
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
  const payload = detail?.draft?.payload ?? detail?.published?.payload ?? detail?.baseline ?? detail?.current.payload ?? detail?.editorSource?.version.payload;
  const isDocument = payload?.kind === "guide" || payload?.kind === "notice";
  return <div className="content-management space-y-4">
    {!detail && ((writer.pending && !writer.busy) || writer.blocked) ? <section className="section-panel space-y-3"><h3 className="text-sm font-semibold">有待核对的内容操作</h3><p className="text-sm text-muted-foreground">原请求保留期间暂停内容写入。请先核对结果。</p><Button type="button" variant="secondary" loading={writer.busy} disabled={writer.blocked} onClick={() => void recover()}>核对原操作结果</Button></section> : null}
    {!detail ? <StatusMessage error={writer.error || error} success={writer.success} /> : null}
    {!detail || !isDocument ? <section className="section-panel space-y-5">
      <div className="content-heading"><div><h3 className="text-base font-semibold">{group === "rules" ? "规则与帮助手册" : "用户页面图片"}</h3><p className="mt-1 text-sm text-muted-foreground">{group === "rules" ? "编辑帮助与说明；保存不改变线上。" : "按位置更换图片；页面文字与跳转不变。"}</p></div><div className="content-heading-meta">{!canEdit ? <Badge variant="unknown">只读</Badge> : null}{group === "rules" && canEdit ? <Button type="button" size="sm" disabled={locked} onClick={() => setCreateOpen(true)}><Plus size={14} aria-hidden="true" />新建手册</Button> : null}</div></div>
      <div className="content-toolbar">
        <div className="content-search"><Search size={15} aria-hidden="true" /><Input aria-label={group === "rules" ? "搜索标题、分类或使用位置" : "搜索首页、市场或二维码位置"} value={search} placeholder={group === "rules" ? "搜索标题、分类或位置" : "搜索首页、市场或位置"} onChange={event => setSearch(event.target.value)} /></div>
        {group === "rules" && game ? <label className="content-inline-field"><span>范围</span><ContentSelect ariaLabel="内容范围" value={scope} disabled={locked} onChange={next => guard(() => setScope(next as "platform" | "game"))} options={[...(platform ? [{ value: "platform", label: "平台内容" }] : []), { value: "game", label: "游戏手册" }]} className="min-w-36" /></label> : null}
        {scope === "game" ? <label className="content-inline-field"><span>游戏</span><ContentSelect ariaLabel="游戏" disabled={locked} value={selectedGame} onChange={next => guard(() => setGameId(next))} options={games.length ? games.map(value => ({ value: value.id, label: value.name })) : [{ value: "", label: "没有可用游戏范围" }]} className="min-w-36" /></label> : null}
        <Button type="button" size="sm" variant="ghost" disabled={loading || locked} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
        <div className="content-state-filter" role="group" aria-label="按状态筛选">{stateChips.map(chip => <Button key={chip.value} type="button" size="sm" variant={stateFilter === chip.value ? "secondary" : "ghost"} aria-pressed={stateFilter === chip.value} disabled={loading} onClick={() => setStateFilter(chip.value)}>{chip.label}<span className="content-state-count">{chip.count}</span></Button>)}</div>
      </div>
      <div className="content-list-meta" role="status" aria-live="polite"><span>{listMeta}</span></div>
      {listError ? <div><StatusMessage error={listError} /><Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>重试读取内容</Button></div> : null}
      {loading || opening ? <div className="space-y-3 py-3" role="status" aria-label={opening ? "读取内容详情" : "读取内容列表"}>{[1, 2, 3].map(value => <div key={value} className="h-12 rounded-lg bg-muted/50" />)}</div> : null}
      {!loading && !listError && listComplete && !visible.length ? <div className="py-10 text-center"><FileText size={24} aria-hidden="true" className="mx-auto text-muted-foreground" /><p className="mt-3 text-sm font-medium">{search || stateFilter !== "all" ? "没有匹配的内容" : "当前范围没有内容"}</p><p className="mt-1 text-sm text-muted-foreground">{search || stateFilter !== "all" ? "调整搜索词或状态筛选后再试。" : group === "rules" && canEdit ? "可以新建一篇帮助手册。" : "有可维护的位置后会显示在这里。"}</p></div> : null}
      {!loading ? groups.map(pageGroup => <div className="content-page-group" key={pageGroup}>{group === "pages" ? <h4 className="mb-2 text-sm font-semibold">{groupLabels[pageGroup as keyof typeof groupLabels] ?? pageGroup}</h4> : null}<div className="content-resource-list">{visible.filter(row => group !== "pages" || (row.definition?.group ?? "site") === pageGroup).map(row => {
        const kind = row.current.payload?.kind ?? row.definition?.kind ?? "guide", state = resourceStateInfo(row), image = row.current.media.find(value => value.url);
        const title = row.current.payload?.title || row.metadata?.title || row.definition?.label || "未命名内容";
        const draftTitle = row.metadata?.hasDraft && row.metadata.title && row.metadata.title !== title ? row.metadata.title : null;
        const caption = [row.definition?.locations.join(" · ") || "帮助中心", RESOURCE_KIND_LABEL[kind], resourceCategoryLabel(row.current.payload), group === "pages" ? resourceRequirement(row.definition) : ""].filter(Boolean).join(" · ");
        return <div className="content-resource-row" key={row.current.key}>
          <div className="content-resource-main">{group === "pages" ? image ? <img src={`/api/bff/admin/content/media/${encodeURIComponent(image.id)}/content`} alt={`${title} 当前图片`} loading="lazy" className="content-resource-thumb" /> : <div className="content-resource-thumb content-resource-thumb-empty"><ImageOff size={18} aria-hidden="true" />{row.current.media.length ? <span>引用不可用</span> : null}</div> : <span className="content-resource-icon"><BookOpen size={17} aria-hidden="true" /></span>}<div className="min-w-0"><p className="content-resource-title">{title}</p><p className="content-resource-caption">{caption}</p>{draftTitle ? <p className="content-resource-draft">草稿标题：{draftTitle}</p> : null}</div></div>
          <div className="content-resource-state"><Badge variant={state.tone}>{state.label}</Badge>{state.detail ? <p className="content-resource-fact">{state.detail}</p> : null}</div>
          <Button type="button" size="sm" variant="secondary" disabled={locked || opening} onClick={() => guard(() => void open(row.current.key))}>{!canEdit ? "查看" : group === "rules" ? "编辑文档" : kind === "contact" ? "更换二维码" : "更换图片"}</Button>
        </div>;
      })}</div></div>) : null}
    </section> : null}
    {detail ? <Suspense fallback={<section className="section-panel py-12 text-sm text-muted-foreground" role="status">加载内容工作面…</section>}>{isDocument ? <DocumentEditor key={`${detail.key}:${editorGeneration}`} detail={detail} canEdit={canEdit} canPublish={canPublish} locked={locked} busy={writer.busy || flowBusy} pending={Boolean(writer.pending) || writer.blocked} operationError={writer.error || error} success={writer.success} onRecover={() => void recover()} onWrite={write} canUpload={hasPermission(snapshot, "content.platform.edit")} canReview={hasPermission(snapshot, "content.platform.publish")} relatedOptions={relatedOptions} canBrowseMedia={platform} onClose={() => guard(() => { ++detailSequence.current; selection.current = null; setDetail(null); dirty(false); })} onDirtyChange={dirty} /> : <MediaEditor key={`${detail.key}:${editorGeneration}`} detail={detail} canEdit={canEdit} canPublish={canPublish} locked={locked} busy={writer.busy || flowBusy} pending={Boolean(writer.pending) || writer.blocked} operationError={writer.error || error} success={writer.success} onRecover={() => void recover()} onWrite={write} canUpload={hasPermission(snapshot, "content.platform.edit")} canReview={hasPermission(snapshot, "content.platform.publish")} onClose={() => guard(() => { ++detailSequence.current; selection.current = null; setDetail(null); dirty(false); })} onDirtyChange={dirty} />}</Suspense> : null}
    <Dialog open={Boolean(deferred)} onOpenChange={open => { if (!open) setDeferred(null); }}><DialogContent role="alertdialog"><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前修改还未保存，继续后将丢失。已经发送且结果待核对的请求不会被取消。</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setDeferred(null)}>继续编辑</Button><Button type="button" variant="danger" onClick={() => { const action = deferred; setDeferred(null); dirty(false); action?.(); }}>放弃修改并继续</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogTitle>新建帮助手册</DialogTitle><DialogDescription>先填写标题，随后编写正文。页面地址会自动生成并保持稳定。</DialogDescription><Field label="文档标题"><Input value={newTitle} onChange={event => setNewTitle(event.target.value)} maxLength={200} autoFocus /></Field><DialogFooter><Button type="button" variant="secondary" disabled={locked} onClick={() => setCreateOpen(false)}>取消</Button><Button type="button" disabled={locked || !newTitle.trim() || (scope === "game" && !selectedGame)} onClick={() => void create()}>创建手册</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
type StorageStatus = { backend: string; configured: boolean; readCheck: "NOT_RUN" | "NO_PUBLIC_SAMPLE" | "PASS" | "FAILED"; checkedAt: string | null };
export function ContentStoragePanel() {
  const [status, setStatus] = useState<StorageStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const load = async (check = false) => { setBusy(true); setError(undefined); try { setStatus(await adminRequest<StorageStatus>(check ? "/content/storage/check" : "/content/storage")); } catch (failure) { setError(friendlyError(failure)); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, []);
  return <div className="content-storage-strip">
    <div className="content-storage-summary"><strong>图片存储</strong>{status ? <span>{status.backend === "local" ? "本地目录" : status.backend === "oss" ? "OSS" : status.backend} · {status.configured ? "已配置" : "未配置"} · {{ NOT_RUN: "读取未检查", NO_PUBLIC_SAMPLE: "无公开样本", PASS: "读取通过", FAILED: "读取失败" }[status.readCheck]}</span> : !error ? <span>读取中…</span> : null}<span className="content-storage-note">已配置仅表示适配器装配。</span></div>
    <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => void load(true)}>检查读取</Button>
    <StatusMessage error={error} />
  </div>;
}
