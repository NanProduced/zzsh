import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Copy, Search, RefreshCw, CheckCircle2 } from "lucide-react";
import { AdminApiError, adminRequest, friendlyError, formatDate, hasPermission, type SessionSnapshot } from "../api";
import { Button } from "../components/ui-elements";
import { SupplyActionDialog, type ActionFeedback } from "./supply-review/action-bar";
import { SupplyDetailPane } from "./supply-review/detail-pane";
import { Lightbox } from "./supply-review/lightbox";
import { blockerLabel, inventoryRows, knownSupplyLink, mediaContentUrl, mediaReviewLabel, orderHandoff, orderPaymentText, reasonIsDirty, restrictionConditions, reviewStateLabel, supplyFactText, supplyObjectLabel, type Detail, type MediaBinding, type QueueItem, type SupplyLinkedOrder, type SupplyWorkDetail, type SupplyWorkPage, type SupplyWorkView, type SupplyQueryKind, type Version, type ZoomTarget } from "./supply-review/model";
type Snapshot = Extract<SessionSnapshot, {
    authenticated: true;
}>;
type Props = {
    snapshot: Snapshot;
    refreshNonce: number;
    onDirtyChange: (dirty: boolean) => void;
    initialAccountId?: string;
    initialQuery: Record<string, string>;
    onOpenPath: (path: string, title?: string) => void;
    onQueryChange: (query: Record<string, string>) => void;
};
type Filter = {
    view: SupplyWorkView;
    kind: SupplyQueryKind;
    q: string;
    gameId: string;
    limit: string;
    cursor: string;
};
type Saved = {
    filter: Filter;
    stack: string[];
    scroll: number;
    windowScroll: number;
    focus: string;
    contextKey?: string;
    stationOrigins?: SupplyWorkPage["stationOrigins"];
};
type Intent = {
    title: string;
    consequence: string;
    conditions?: string[];
    objectLabel: string;
    permission: string;
    path: string;
    body: Record<string, unknown>;
    context: string;
    success: string;
    assetId?: string;
    request?: {
        body: Record<string, unknown>;
        key: string;
    };
    unknown?: boolean;
    invalid?: boolean;
};
const positions = new Map<string, Saved>();
const views = [["all", "全部账号"], ["changes", "最近资料变更"], ["restricted", "运营限制"], ["paused", "号主暂停"], ["orders", "有关联订单"]] as const;
const sections = [["situation", "当前情况"], ["changes", "变更与图片"], ["review", "限制复核"], ["orders", "履约关系"], ["archive", "完整档案"]] as const;
const lookup = [["account", "账号业务编号 / 稳定ID"], ["legacy", "旧来源编号"], ["owner", "号主稳定ID / 旧用户ID"], ["nickname", "号主昵称"], ["link", "本站账号/订单链接"], ["order", "关联订单号"]] as const;
const parseCursorHistory = (value: string | undefined): string[] => { try {
    const result = JSON.parse(value ?? "[]");
    return Array.isArray(result) && result.length <= 32 && result.every(c => typeof c === "string" && c.length <= 2048 && (c === "" || /^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]{43}$/.test(c))) ? result : [];
}
catch {
    return [];
} };
const emptyFilter: Filter = { view: "all", kind: "account", q: "", gameId: "", limit: "5", cursor: "" };
const fail = (error: unknown) => error instanceof AdminApiError && error.status === 409 ? "查询或确认上下文已变化，请回到首页或重新核对。" : friendlyError(error);
export function SupplyListingReviewView(props: Props) {
    if (!hasPermission(props.snapshot, "supply.review.read"))
        return <p className="p-6 text-sm text-muted-foreground">没有账号供给读取权限，未读取对象数据。</p>;
    return <SupplyWork key={[props.snapshot.adminUserId, props.snapshot.session.id, props.snapshot.security.isBoss, [...props.snapshot.permissions].sort().join(","), props.initialAccountId ?? "list"].join("|")} {...props}/>;
}
function SupplyWork({ snapshot, refreshNonce, onDirtyChange, initialAccountId, initialQuery, onOpenPath, onQueryChange }: Props) {
    const identity = snapshot.adminUserId + "|" + snapshot.session.id, can = (permission: string) => hasPermission(snapshot, permission), saved = positions.get(identity);
    const [filter, setFilter] = useState<Filter>(() => saved?.filter ?? { ...emptyFilter, view: views.some(v => v[0] === initialQuery.view) ? initialQuery.view as SupplyWorkView : "all", kind: lookup.some(k => k[0] === initialQuery.queryKind) ? initialQuery.queryKind as SupplyQueryKind : "account", q: initialQuery.q ?? "", gameId: initialQuery.gameId ?? "", limit: ["5", "20", "50"].includes(initialQuery.limit ?? "") ? initialQuery.limit! : "5", cursor: initialQuery.cursor ?? "" });
    const [draftKind, setDraftKind] = useState<SupplyQueryKind>(saved?.filter.kind ?? filter.kind), [draftQ, setDraftQ] = useState(saved?.filter.q ?? filter.q);
    const [stack, setStack] = useState<string[]>(saved?.stack ?? parseCursorHistory(initialQuery.supplyCursorHistory)), [page, setPage] = useState<SupplyWorkPage>(), [listBusy, setListBusy] = useState(!initialAccountId), [listError, setListError] = useState<string>(), [queryError, setQueryError] = useState<string>();
    const origins = useRef<SupplyWorkPage["stationOrigins"] | undefined>(saved?.stationOrigins);
    const [detail, setDetail] = useState<SupplyWorkDetail>(), [detailBusy, setDetailBusy] = useState(Boolean(initialAccountId)), [detailError, setDetailError] = useState<string>(), [versionId, setVersionId] = useState<string | null>(initialQuery.versionId ?? null);
    const [section, setSection] = useState<string>(sections.some(s => s[0] === initialQuery.context) ? initialQuery.context ?? "situation" : "situation"), [archiveTab, setArchiveTab] = useState<"data" | "media" | "history">("data");
    const [reason, setReason] = useState(""), [checked, setChecked] = useState(false), [intent, setIntent] = useState<Intent>(), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<ActionFeedback>(), [readFailed, setReadFailed] = useState(false);
    const [zoom, setZoom] = useState<ZoomTarget>(), [copyNotice, setCopyNotice] = useState(""), [manualSummary, setManualSummary] = useState<string>(), [related, setRelated] = useState(""), [relatedItems, setRelatedItems] = useState<QueueItem[]>([]);
    const [broaderMatch, setBroaderMatch] = useState<boolean>();
    const listSeq = useRef(0), detailSeq = useRef(0), alive = useRef(true), actionLock = useRef(false), viewport = useRef<HTMLDivElement>(null);
    const closeZoom = useCallback(() => setZoom(undefined), []);
    useEffect(() => { alive.current = true; return () => { alive.current = false; listSeq.current++; detailSeq.current++; }; }, []);
    const detailPath = useCallback(() => "/supply/listing-reviews/" + encodeURIComponent(initialAccountId!) + "?" + new URLSearchParams({ queryVersion: "3", ...(versionId ? { versionId } : {}) }), [initialAccountId, versionId]);
    const loadDetail = useCallback(async (signal?: AbortSignal) => { const seq = ++detailSeq.current; const value = await adminRequest<SupplyWorkDetail>(detailPath(), undefined, "GET", {}, signal); if (!alive.current || seq !== detailSeq.current || signal?.aborted)
        return; setDetail(value); setDetailError(undefined); return value; }, [detailPath]);
    const loadList = useCallback(async (signal?: AbortSignal) => {
        const seq = ++listSeq.current;
        setBroaderMatch(undefined);
        let kind = filter.kind, q = filter.q;
        if (kind === "link") {
            if (!origins.current)
                throw new Error("站内地址配置尚未读取，请刷新列表。");
            const parsed = knownSupplyLink(q, origins.current);
            if (!parsed)
                throw new Error("不是已知本站账号或订单路径，未读取外部地址。");
            kind = parsed.kind === "order" ? "order" : "account";
            q = parsed.id;
        }
        const params = new URLSearchParams({ queryVersion: "3", view: filter.view, queryKind: kind, q, gameId: filter.gameId, limit: filter.limit, ...(filter.cursor ? { cursor: filter.cursor } : {}) });
        const value = await adminRequest<SupplyWorkPage>("/supply/listing-reviews?" + params, undefined, "GET", {}, signal);
        if (!alive.current || seq !== listSeq.current || signal?.aborted)
            return;
        origins.current = value.stationOrigins;
        setPage(value);
        if (value.items.length === 0 && filter.view !== "all" && q.trim() && !filter.cursor) {
            void (async () => {
                try {
                    const probe = await adminRequest<SupplyWorkPage>("/supply/listing-reviews?" + new URLSearchParams({ queryVersion: "3", view: "all", queryKind: kind, q, gameId: filter.gameId, limit: "5" }), undefined, "GET", {}, signal);
                    if (!alive.current || seq !== listSeq.current || signal?.aborted)
                        return;
                    setBroaderMatch((probe.items?.length ?? 0) > 0);
                }
                catch {
                    // 探测失败保持未知，不追加提示。
                }
            })();
        }
        return value;
    }, [filter]);
    useEffect(() => { if (initialAccountId)
        return; const controller = new AbortController(); setListBusy(true); setListError(undefined); setPage(undefined); void loadList(controller.signal).then(value => { if (!value || controller.signal.aborted)
        return; const prior = positions.get(identity); if (prior?.contextKey && prior.contextKey !== value.contextKey) {
        positions.delete(identity);
        setStack([]);
        setFilter({ ...emptyFilter });
        return;
    } requestAnimationFrame(() => { const scroller = viewport.current?.closest(".workspace-page"); if (scroller && prior)
        scroller.scrollTop = prior.scroll; window.scrollTo(0, prior?.windowScroll ?? 0); (document.getElementById(prior?.focus ?? "") ?? document.getElementById("supply-work-title"))?.focus({ preventScroll: true }); }); }).catch(error => { if (!controller.signal.aborted)
        setListError(fail(error)); }).finally(() => { if (!controller.signal.aborted)
        setListBusy(false); }); return () => { controller.abort(); listSeq.current++; }; }, [initialAccountId, loadList, refreshNonce, identity]);
    useEffect(() => { if (!initialAccountId)
        return; const controller = new AbortController(); setDetailBusy(true); setDetailError(undefined); setDetail(undefined); setChecked(false); void loadDetail(controller.signal).catch(error => { if (!controller.signal.aborted)
        setDetailError(fail(error)); }).finally(() => { if (!controller.signal.aborted)
        setDetailBusy(false); }); return () => { controller.abort(); detailSeq.current++; }; }, [initialAccountId, loadDetail, refreshNonce]);
    useEffect(() => { onDirtyChange(!!intent || reasonIsDirty(reason)); return () => onDirtyChange(false); }, [intent, reason, onDirtyChange]);
    useEffect(() => { if (!initialAccountId)
        return; window.scrollTo(0, 0); document.getElementById("supply-detail-title")?.focus({ preventScroll: true }); }, [initialAccountId, detail?.account.id]);
    useEffect(() => { if (!feedback || intent)
        return; const target = viewport.current?.querySelector<HTMLElement>(".wf-result"); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "center" }); }, [feedback, intent]);
    useEffect(() => { if (section !== "archive" || !detail || !can("supply.duplicate.review"))
        return; let active = true; void adminRequest<SupplyWorkPage>("/supply/listing-reviews?" + new URLSearchParams({ queryVersion: "3", gameId: detail.account.game_id, limit: "50" })).then(data => { if (active)
        setRelatedItems(data.items.map(r => ({ id: r.id, game_id: detail.account.game_id, title: r.title, owner_name: r.ownerName, game_name: r.gameName, review_state: r.reviewState ?? "", sequence: r.sequence ?? "", owner_paused: r.facts.ownerPaused, staff_restricted: r.facts.staffRestricted }))); }).catch(() => { if (active)
        setRelatedItems([]); }); return () => { active = false; }; }, [section, detail?.account.id, detail?.account.game_id, can("supply.duplicate.review")]);
    useEffect(() => { if (initialAccountId)
        return; onQueryChange({ view: filter.view, queryKind: filter.kind, q: filter.q, gameId: filter.gameId, limit: filter.limit, cursor: filter.cursor, supplyCursorHistory: JSON.stringify(stack) }); }, [filter, stack, initialAccountId]);
    const remember = (focus: string) => positions.set(identity, { filter, stack, scroll: viewport.current?.closest(".workspace-page")?.scrollTop ?? 0, windowScroll: window.scrollY, focus, contextKey: page?.contextKey ?? saved?.contextKey, stationOrigins: origins.current });
    const open = (id: string, title: string, context: string) => { remember("supply-open-" + id); onOpenPath("/supply/reviews/" + encodeURIComponent(id) + "?context=" + context, title); };
    const back = () => onOpenPath("/supply/reviews");
    const goSection = (value: string) => { if (intent?.unknown || busy)
        return; setSection(value); onQueryChange({ ...initialQuery, context: value, ...(versionId ? { versionId } : {}) }); };
    const userTarget = () => { if (!detail || detail.supervision.ownerLink.state !== "READY")
        return; onOpenPath("/users/" + encodeURIComponent(detail.account.owner_user_id) + "?" + new URLSearchParams({ fromSupplyId: detail.account.id, fromSupplyContext: section, ...(versionId ? { fromSupplyVersionId: versionId } : {}) }), detail.ownerName); };
    const orderTarget = (id: string, title: string) => { if (!detail || !can("order.read"))
        return; onOpenPath("/orders/" + encodeURIComponent(id) + "?" + new URLSearchParams({ fromSupplyId: detail.account.id, fromSupplyContext: section, ...(versionId ? { fromSupplyVersionId: versionId } : {}) }), title); };
    const summary = detail ? supplyFactText(detail.supervision.facts) : null, objectLabel = detail ? supplyObjectLabel({ id: detail.account.id, displayNo: detail.account.display_no, facts: detail.supervision.facts }) : "";
    const handoff = detail ? [objectLabel, "当前资料 第" + (detail.version?.sequence ?? "未提供") + "版 · 修订" + detail.account.revision, "当前号主：" + detail.ownerName + " · " + detail.account.owner_user_id, summary!.display + "；" + summary!.newOrders, summary!.reason, "核对说明：" + (reason || "尚未填写"), "既有订单按原主体/资料单独核对。"].join("\n") : "";
    const copy = async (order?: SupplyLinkedOrder) => { if (!detail || order && (!can("order.read") || detail.supervision.orders.state !== "READY")) return; const text = order ? orderHandoff(detail, order, handoff) : handoff; setManualSummary(text); try {
        await navigator.clipboard.writeText(text);
        setCopyNotice("核对摘要已复制，可沿现有号主或本单客服沟通交接；没有自动发送。");
    }
    catch {
        setCopyNotice("剪贴板不可用，请展开最近选择的摘要后手动复制。");
    } };
    const actionContext = (data: SupplyWorkDetail, assetId?: string) => JSON.stringify({ contextKey: data.contextKey, account: data.account, facts: data.supervision.facts, versionId: data.version?.id, versionRevision: (data.version as Version & {
            revision?: string;
        })?.revision, release: data.version?.releaseId, hash: data.version?.contentHash, historical: data.supervision.historical, media: assetId ? data.version?.declaration.mediaBindings.find(m => m.assetId === assetId) : undefined });
    const begin = (kind: "restriction" | "media" | "duplicate" | "APPROVE" | "REJECT", assetId?: string, decision?: "QUARANTINE" | "APPROVE") => {
        if (!detail || detail.supervision.historical || readFailed || actionLock.current || intent?.unknown || !detail.version)
            return;
        const a = detail.account, v = detail.version;
        let path = "", body: Record<string, unknown> = {}, permission = "", title = "", consequence = "", success = "";
        if (kind === "restriction") {
            permission = "supply.restrict";
            if (a.staff_restricted && (!checked || reason.trim().length < 2))
                return;
            path = "/supply/listing-reviews/" + a.id + "/restriction";
            body = { expectedRevision: a.revision, restricted: !a.staff_restricted };
            title = a.staff_restricted ? "解除运营限制" : "施加运营限制";
            success = a.staff_restricted ? "运营限制已解除" : "运营限制已施加";
            consequence = "仅改变运营限制，不恢复号主暂停、不自动发布资料。既有订单及其原主体、金额与资料不变。";
        }
        else if (kind === "media") {
            permission = "supply.review.decide";
            const media = v.declaration.mediaBindings.find(m => m.assetId === assetId && m.purpose === "ACCOUNT_DISPLAY");
            if (!media?.byteHash || !media.mediaRevision)
                return;
            path = "/supply/media/" + assetId + "/review";
            body = { decision, accountContext: { accountId: a.id, accountRevision: a.revision, versionId: v.id, assetRevision: media.mediaRevision, byteHash: media.byteHash }, ...(decision === "APPROVE" ? { visibility: "PUBLIC_DISPLAY" } : {}) };
            title = decision === "APPROVE" ? "恢复当前展示图" : "隔离当前展示图";
            success = decision === "APPROVE" ? "本图处置已恢复" : "本图已隔离";
            consequence = "仅处置这张账号展示图，版本和图片变化会作废旧确认。其他阻断仍独立核对；既有订单不自动改变。";
        }
        else if (kind === "duplicate") {
            permission = "supply.duplicate.review";
            if (!related || !relatedItems.some(r => r.id === related && r.id !== a.id && r.game_id === a.game_id))
                return;
            const evidence = v.declaration.mediaBindings[0]?.assetId;
            if (!evidence)
                return;
            path = "/supply/listing-reviews/" + a.id + "/duplicates";
            body = { expectedRevision: a.revision, relatedAccountId: related, result: "POSSIBLE_SAME", evidenceRef: "asset:" + evidence };
            title = "记录关联线索";
            success = "关联线索已记录";
            consequence = "仅记录受权同游戏对象的人工判断，不自动合并或变更归属。";
        }
        else {
            permission = "supply.review.decide";
            if (v.reviewState !== "SUBMITTED")
                return;
            path = "/supply/listing-reviews/" + a.id + "/decide";
            body = { expectedRevision: a.revision, versionId: v.id, releaseId: v.releaseId, contentHash: v.contentHash, decision: kind };
            title = kind === "APPROVE" ? "通过历史审核" : "退回历史审核";
            success = kind === "APPROVE" ? "历史审核已通过" : "历史审核已退回";
            consequence = "只处理当前SUBMITTED旧合同资料；号主直发仍免预审，其他阻断保留。";
        }
        if (!can(permission))
            return;
        setFeedback(undefined);
        const originalReason = detail.supervision.restrictionHistory.items.find(event => event.restricted === true)?.reason;
        setIntent({ title, success, consequence: consequence + (kind === "restriction" && originalReason ? " 原限制原因：" + originalReason : ""), conditions: kind === "restriction" ? restrictionConditions(detail) : undefined, permission, path, body, context: actionContext(detail, assetId), assetId, objectLabel: objectLabel + " · 第" + v.sequence + "版 · 修订" + a.revision });
    };
    const stale = Boolean(intent && (intent.invalid || !detail || intent.context !== actionContext(detail, intent.assetId)));
    const confirm = async () => {
        const current = intent;
        if (!current || !can(current.permission) || !alive.current || actionLock.current || !initialAccountId || !current.unknown && (stale || reason.trim().length < 2))
            return;
        const request = current.request ?? { body: { ...current.body, reason }, key: "idem_" + crypto.randomUUID().replaceAll("-", "") };
        actionLock.current = true;
        setBusy(true);
        setIntent({ ...current, request });
        setFeedback(undefined);
        try {
            await adminRequest(current.path, request.body, "POST", { "idempotency-key": request.key });
        }
        catch (error) {
            if (!alive.current)
                return;
            const unknown = !(error instanceof AdminApiError) || error.status === 0 || error.status >= 500 || error.status === 408;
            setIntent({ ...current, request, unknown, invalid: !unknown });
            setFeedback({ kind: "error", message: unknown ? "结果未确认，原对象、原因和请求已冻结；只能核对同一次处置。" : fail(error) });
            actionLock.current = false;
            setBusy(false);
            return;
        }
        if (!alive.current)
            return;
        setIntent(undefined);
        setReason("");
        setChecked(false);
        setReadFailed(true);
        setDetailBusy(true);
        try {
            const value = await loadDetail();
            if (value)
                setReadFailed(false);
        }
        catch (error) {
            if (alive.current) {
                setDetail(undefined);
                setDetailError(fail(error));
            }
        }
        if (!alive.current)
            return;
        setDetailBusy(false);
        actionLock.current = false;
        setBusy(false);
        setFeedback({ kind: "success", message: current.success + "。请核对当前状态与剩余条件；已接受的处置不会重新提交。" });
    };
    const reread = async () => { if (!initialAccountId)
        return; setDetailBusy(true); try {
        const value = await loadDetail();
        if (value)
            setReadFailed(false);
    }
    catch (error) {
        if (alive.current)
            setDetailError(fail(error));
    }
    finally {
        if (alive.current)
            setDetailBusy(false);
    } };
    const image = (binding: MediaBinding | undefined, caption: string) => binding ? <button className="wf-image wf-review-image" aria-label={"放大核对 " + caption} onClick={() => setZoom({ src: mediaContentUrl(binding.assetId), alt: caption, caption })}><img src={mediaContentUrl(binding.assetId)} alt={caption} loading="lazy"/><span>{caption} · {mediaReviewLabel(binding)} · 放大核对</span></button> : <p className="wf-hint">未提供对应图片，不能视作证据已核齐。</p>;
    const submitSearch = (event: React.FormEvent) => { event.preventDefault(); setQueryError(undefined); if (/(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/.test(draftQ)) {
        setQueryError("手机号请从用户管理按独立权限查找。");
        return;
    } if (draftKind === "link" && (!page || !knownSupplyLink(draftQ.trim(), page.stationOrigins))) {
        setQueryError("不是已知本站账号或订单路径，未读取外部地址。");
        return;
    } let kind = draftKind, q = draftQ.trim(); if (kind === "link") {
        const parsed = knownSupplyLink(q, page!.stationOrigins)!;
        kind = parsed.kind === "order" ? "order" : "account";
        q = parsed.id;
    } setStack([]); setFilter({ ...filter, kind, q, cursor: "" }); positions.delete(identity); };
    if (!initialAccountId)
        return <div className="wf-list" ref={viewport}><header className="wf-page-head"><div><h1 id="supply-work-title" tabIndex={-1}>账号供给</h1><p>找账号、核对当前情况，处理影响展示、接单与履约的问题。</p></div><Button variant="secondary" onClick={() => setFilter({ ...filter })}><RefreshCw size={15}/>刷新列表</Button></header><nav className="wf-work-views" aria-label="供给工作视图">{views.map(([value, label]) => <button key={value} aria-pressed={filter.view === value} onClick={() => { positions.delete(identity); setStack([]); setFilter({ ...filter, view: value, cursor: "" }); onQueryChange({ view: value }); }}>{label}</button>)}</nav>
 <form className="wf-search" onSubmit={submitSearch}><label>查找方式<select aria-label="查找方式" value={draftKind} onChange={e => setDraftKind(e.target.value as SupplyQueryKind)}>{lookup.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wf-search-value">业务线索<div><Search size={16}/><input aria-label="业务线索" value={draftQ} maxLength={128} autoComplete="off" onChange={e => setDraftQ(e.target.value)} placeholder={draftKind === "nickname" ? "昵称可能重名，请核对主体" : "编号或已知本站链接"}/></div></label><label>游戏<select aria-label="游戏" value={filter.gameId} onChange={e => { positions.delete(identity); setStack([]); setFilter({ ...filter, gameId: e.target.value, cursor: "" }); }}><option value="">当前范围全部游戏</option>{page?.games?.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}</select></label><Button type="submit" disabled={listBusy}>查找</Button><Button variant="ghost" onClick={() => { positions.delete(identity); setDraftQ(""); setStack([]); setFilter({ ...filter, q: "", cursor: "" }); setQueryError(undefined); }}>清除线索</Button></form>
 {queryError && <p role="alert" className="wf-warning">{queryError}</p>}{filter.kind === "nickname" && filter.q && <p className="wf-hint">昵称可返回多候选。请核对稳定ID/旧来源，不按昵称合并主体。</p>}
 <div className="wf-list-meta"><span>{listBusy ? "正在读取当前列表…" : "本页 " + (page?.items.length ?? 0) + " 条 · 最近资料版本时间排序"}</span><label>每页 <select aria-label="每页条数" value={filter.limit} onChange={e => { positions.delete(identity); setStack([]); setFilter({ ...filter, limit: e.target.value, cursor: "" }); }}>{["5", "20", "50"].map(n => <option key={n}>{n}</option>)}</select> 条 · 当前授权范围</label></div>
 {listError ? <div className="wf-empty" role="alert"><h2>本次列表未读到</h2><p>{listError}</p><Button onClick={() => { positions.delete(identity); setStack([]); setFilter({ ...filter, cursor: "" }); }}>回首页重读</Button></div> : listBusy ? <div className="wf-empty" aria-busy="true">正在读取账号供给…</div> : <div className="wf-table-wrap"><table className="wf-table"><thead><tr><th>账号 / 当前号主</th><th>当前情况与主要原因</th><th className="wf-wide">最近资料版本</th><th>核对入口</th></tr></thead><tbody>{page?.items.map(row => { const facts = supplyFactText(row.facts), label = supplyObjectLabel(row), context = row.facts.staffRestricted ? "review" : filter.view === "changes" ? "changes" : filter.view === "orders" ? "orders" : "situation"; return <tr key={row.id}><td><strong>{label}</strong><span>{row.title ?? "资料未提供"}</span><small>{row.ownerName} · {row.ownerId}</small>{row.facts.legacyNumbers.length > 1 && <small>多个旧来源号，需按来源核对</small>}</td><td><strong>{facts.display}</strong><span>{facts.newOrders}</span><small className={row.facts.staffRestricted ? "wf-warning" : ""}>{facts.reason}</small></td><td className="wf-wide"><span>{reviewStateLabel(row.reviewState ?? "未提供")} · 第{row.sequence ?? "未知"}版</span><small>{formatDate(row.sortAt)}</small></td><td><button className="wf-link" id={"supply-open-" + row.id} aria-label={"查看 " + label} onClick={() => open(row.id, label, context)}>核对当前情况</button></td></tr>; })}{!page?.items.length && <tr><td colSpan={4}><div className="wf-empty"><h2>当前范围没有匹配账号</h2><p>查询/视图保留；不代表范围外或全平台没有账号。{filter.view === "restricted" ? "已解除的账号不再匹配运营限制视图，可返回全部账号核对剩余问题。" : ""}</p>{broaderMatch ? <p className="wf-hint">同一线索在“全部账号”视图下有匹配，被当前“{views.find(v => v[0] === filter.view)?.[1]}”视图条件过滤；可切换视图核对。</p> : null}</div></td></tr>}</tbody></table></div>}
 <footer className="wf-footer"><span>解除限制不等于上架；既有订单按原事实核对。</span><div><Button variant="secondary" disabled={!stack.length || listBusy} onClick={() => { positions.delete(identity); const prior = [...stack], cursor = prior.pop()!; setStack(prior); setFilter({ ...filter, cursor }); }}>上一页</Button><span>第{stack.length + 1}页</span><Button variant="secondary" disabled={!page?.nextCursor || listBusy} onClick={() => { positions.delete(identity); setStack([...stack, filter.cursor]); setFilter({ ...filter, cursor: page!.nextCursor! }); }}>下一页</Button></div></footer></div>;
    const version = detail?.version, original = detail?.supervision.restrictionHistory.items.find(e => e.restricted === true), currentMedia = version?.declaration.mediaBindings.find(m => m.purpose === "ACCOUNT_DISPLAY" && (!initialQuery.assetId || m.assetId === initialQuery.assetId)), previous = detail?.supervision.previousVersion, previousMedia = detail?.supervision.originalRestrictionVersion?.declaration.mediaBindings.find(m => m.purpose === "ACCOUNT_DISPLAY"), historical = detail?.supervision.historical ?? false, restricted = detail?.account.staff_restricted ?? false;
    return <section className="wf-detail" ref={viewport}><div className="wf-back"><Button variant="secondary" onClick={back} disabled={busy || intent?.unknown}><ArrowLeft size={15}/>返回账号供给</Button><span>{version ? "第" + version.sequence + "版" : "资料读取"}{detail ? " · 修订" + detail.account.revision : ""}</span></div>
 {feedback && !intent && <div role="status" tabIndex={-1} className="wf-result"><CheckCircle2 size={19}/><div><h2>{feedback.message}</h2>{readFailed && <p>当前详情未读到，只重读本次结果。</p>}</div>{readFailed && <Button variant="secondary" disabled={detailBusy} onClick={() => void reread()}>只重读本次结果</Button>}</div>}
 {detailBusy && !detail ? <div className="wf-empty" aria-busy="true">正在读取账号详情…</div> : detailError && !detail ? <div className="wf-empty" role="alert"><h1>本次详情未读到</h1><p>{detailError}</p><Button onClick={() => void reread()} disabled={busy}>重读当前账号</Button></div> : detail && <>
 <header className="wf-page-head"><div><h1 id="supply-detail-title" tabIndex={-1}>{objectLabel} <span className="wf-object-description">{version?.declaration.title ?? "当前资料未提供"}</span></h1><p className="wf-owner-line">当前号主：{detail.ownerName} · {detail.account.owner_user_id}</p></div></header>
 {historical && <div className="wf-notice" role="status"><p>正在查看历史版本，所有处置关闭。业务情况仍指当前账号。</p><Button variant="secondary" onClick={() => { setVersionId(null); setChecked(false); setReason(""); const query: Record<string, string> = { ...initialQuery, context: section }; delete query.versionId; onQueryChange(query); }}>回到当前资料</Button></div>}
 <section className="wf-situation"><div><h2>{summary!.display} <span>· {summary!.newOrders}</span></h2><p className="wf-primary-reason">{summary!.reason}</p></div><details className="wf-authority"><summary>核对发布、暂停、限制与占用事实</summary><dl><div><dt>资料状态</dt><dd>{version ? reviewStateLabel(version.reviewState) : "未提供"}</dd></div><div><dt>公开来源</dt><dd>{detail.supervision.facts.publicSource === "LEGACY_READ_ONLY" ? "旧来源只读公开，不能据此新建订单" : detail.supervision.facts.publicSource === "NATIVE_PUBLICATION" ? "有效原生发布" : "当前无可读公开事实"}</dd></div><div><dt>号主暂停</dt><dd>{detail.account.owner_paused ? "是" : "否"}</dd></div><div><dt>运营限制</dt><dd>{restricted ? "限制中" : "无运营限制"}</dd></div><div><dt>接单阻断</dt><dd>{detail.supervision.facts.reasons.map(blockerLabel).join("；") || "当前无阻断"}</dd></div><div><dt>占用</dt><dd>{detail.supervision.facts.occupancy === "UNKNOWN" ? "未核定" : detail.supervision.facts.occupancy === "OCCUPIED" ? "占用中" : "当前无占用"}</dd></div></dl></details></section>
 <nav className="wf-sections" aria-label="账号核对分区">{sections.map(([key, label]) => <button key={key} aria-pressed={section === key} onClick={() => goSection(key)}>{label}</button>)}</nav>
 {section === "situation" && <div className="wf-reading wf-work-face"><section><h2>{detail.account.owner_paused ? "核对暂停，与当前号主确认恢复意愿" : restricted ? "核对原限制及后续资料" : version?.reviewState === "DRAFT" ? "核对资料与发布依据" : "核对当前原因与相关资料"}</h2><p>{detail.account.owner_paused ? "号主暂停由号主按既有入口恢复，解除运营限制不会代替其恢复公开。" : summary!.reason}</p><dl className="wf-definitions"><div><dt>当前资料</dt><dd>{version ? "第" + version.sequence + "版 · " + reviewStateLabel(version.reviewState) : "未提供"}</dd></div><div><dt>已知来源</dt><dd>{detail.supervision.facts.sources.length ? detail.supervision.facts.sources.map(s => s.sourceSystem + "/" + s.sourceEntity + " · " + s.sourceId + "（旧编号：" + (s.businessNo ?? "待核") + "）").join("；") : "未记录旧来源"}</dd></div><div><dt>旧业务编号</dt><dd>{detail.supervision.facts.legacyNumbers.length ? detail.supervision.facts.legacyNumbers.join("、") : "未记录旧业务编号"}</dd></div></dl><div className="wf-task-actions">{detail.supervision.ownerLink.state === "READY" && <Button onClick={userTarget}>查看号主与关联资料</Button>}<Button variant="secondary" onClick={() => void copy()}>复制给号主的核对摘要</Button></div></section><section><h2>与当前问题有关的核对</h2><div className="wf-related"><button className="wf-link" onClick={() => goSection("changes")}>查看相关资料与图片<ArrowUpRight size={13}/></button>{restricted && <button className="wf-link" onClick={() => goSection("review")}>核对原限制与新证据<ArrowUpRight size={13}/></button>}<button className="wf-link" onClick={() => goSection("orders")}>核对关联订单<ArrowUpRight size={13}/></button></div><p className="wf-hint">直发免预审。员工协助维护需求保留，当前没有任意代改库存、价格或身份入口。</p></section></div>}
 {section === "changes" && <div className="wf-comparison wf-work-face"><section><h2>本版申报与对应图片</h2>{version ? <><table className="wf-table"><thead><tr><th>申报项</th><th>{previous ? "前版 " + previous.sequence : "前版未提供"}</th><th>当前第{version.sequence}版</th></tr></thead><tbody>{inventoryRows(version, detail.previousDeclaration, detail.previousPresentation?.items).map(row => <tr key={row.itemId}><th>{row.name} · {row.unit}</th><td>{row.previous}</td><td>{row.current}</td></tr>)}</tbody></table>{image(currentMedia, "本版相关展示图")}<p className="wf-hint">前版差异来自记录的资料版本，不作自动风险判断；完整字段在档案中核对。</p></> : <p>当前没有资料版本，不能编造库存或图片。</p>}</section><section><h2>核对结论与处理</h2>{currentMedia && can("supply.review.decide") ? <><label className="wf-form-label">本次图片核对说明<textarea aria-label="本次图片核对说明" value={reason} disabled={historical || readFailed || busy} onChange={e => setReason(e.target.value)} maxLength={500}/></label><Button variant="danger" disabled={historical || readFailed || busy || reason.trim().length < 2 || !currentMedia.mediaRevision || !currentMedia.byteHash} onClick={() => begin("media", currentMedia.assetId, currentMedia.reviewState === "QUARANTINED" ? "APPROVE" : "QUARANTINE")}>{currentMedia.reviewState === "QUARANTINED" ? "核对后恢复本图" : "确认前核对并隔离本图"}</Button><p className="wf-hint">确认绑定当前账号修订、资料版、图片修订与字节摘要；其他阻断仍独立核对。</p></> : <p>{currentMedia ? "当前没有图片处置权限，可核对并交受权人员处理。" : initialQuery.assetId ? "所选图片未绑定当前版本，只能核对历史/未绑定来源；合法后续处理合同尚待补齐。" : "没有可处置的当前展示图。"}来源缺失不认定图文正确。</p>}<div className="wf-task-actions">{detail.supervision.ownerLink.state === "READY" && <Button variant="secondary" onClick={userTarget}>查看当前号主资料</Button>}<Button variant="secondary" onClick={() => void copy()}>复制修订核对摘要</Button></div></section></div>}
 {section === "review" && <div className="wf-review wf-work-face"><section><h2>原限制：核对问题与证据</h2><p className="wf-review-cause">{original?.reason ?? (restricted ? detail.account.restriction_reason : "未提供已施加的原限制记录") ?? "原因未记录"}</p><p className="wf-hint">{original?.actorName ?? "处理人未记录"} · {original ? formatDate(original.occurredAt) : "时间未记录"} · {original?.beforeRevision ? "原修订" + original.beforeRevision : "原修订未提供"}</p>{image(original?.versionId === version?.id ? currentMedia : previousMedia, "原版相关展示图")}<p className="wf-hint">图片仅是对应版本资料，原审计未绑定具体图时不宣称它就是原限制依据。原记录保留。</p></section><section><h2>本次资料：核对后再处置</h2><p>{version ? "当前第" + version.sequence + "版 · " + reviewStateLabel(version.reviewState) : "当前资料未提供"}</p>{image(currentMedia, "当前新版相关展示图")}<p className="wf-hint">{summary!.reason}。查看图片不会自动完成复核。</p></section><section><h2>核对结论与处置</h2>{can("supply.restrict") && version ? <div className="wf-review-form">{restricted && <label className="wf-check"><input type="checkbox" aria-label="已核对当前资料且原限制问题已解决" checked={checked} disabled={historical || readFailed || busy} onChange={e => setChecked(e.target.checked)}/>我已核对当前资料，确认原限制问题已解决</label>}<label>{restricted ? "本次解除依据与说明" : "已核对的问题与限制原因"}<textarea aria-label={restricted ? "本次解除依据与说明" : "已核对的问题与限制原因"} value={reason} disabled={historical || readFailed || busy} onChange={e => setReason(e.target.value)} maxLength={500}/></label><Button variant="danger" disabled={historical || readFailed || busy || reason.trim().length < 2 || restricted && !checked} onClick={() => begin("restriction")}>{restricted ? "核对完成，确认解除影响" : "核对后确认运营限制"}</Button><p className="wf-hint">对象/版本/权限/原因在确认时再核。号主暂停、其他资格与既有订单独立保留。</p></div> : <p className="wf-warning">当前只读监管依据，没有运营限制处置权限。</p>}<details className="wf-secondary-action"><summary>原记录与交接</summary>{detail.supervision.restrictionHistory.items.map(e => <p key={e.id}>{e.restricted === true ? "施加限制" : e.restricted === false ? "解除限制" : "处置状态未记录"} · {e.reason ?? "原因未记录"} · {e.actorName ?? "处理人未记录"} · {formatDate(e.occurredAt)}</p>)}<p>显示最近{detail.supervision.restrictionHistory.limit}条相关成功事件；未记录不等于无历史问题。</p><Button variant="secondary" onClick={() => void copy()}>复制给复核人员的摘要</Button></details></section></div>}
 {section === "orders" && <div className="wf-order-context wf-work-face"><section><h2>当前账号与号主</h2><dl className="wf-definitions"><div><dt>当前号主</dt><dd>{detail.ownerName} · {detail.account.owner_user_id}</dd></div><div><dt>当前资料</dt><dd>{version ? "第" + version.sequence + "版" : "未提供"}</dd></div></dl><p className="wf-hint">本单原主体与冻结资料按订单接口保留，不用当前号主或资料覆盖。</p>{detail.supervision.ownerLink.state === "READY" && <button className="wf-link" onClick={userTarget}>查看当前号主<ArrowUpRight size={13}/></button>}</section><section><h2>关联订单与履约入口</h2>{detail.supervision.orders.state === "DENIED" ? <p className="wf-warning">没有订单读取权限，原双方和订单数量不显示为0。</p> : <>{detail.supervision.orders.items?.map(order => <div className="wf-linked-order" key={order.id}><strong className="wf-order-no">{order.displayNo}</strong><p>{order.source.statusLabel ?? order.status} · {orderPaymentText(order.payment.state)}</p><p>本单原号主：{order.ownerName ?? "未提供"} · 租客：{order.renterName ?? "未提供"}</p><p>订单资料：{order.versionId ? "已冻结原版本" : "旧版本引用未完整，不能编造"}；{order.ownerUserId !== detail.account.owner_user_id ? "当前号主与本单原号主不同。" : "当前号主与本单原号主相同。"}</p><div className="wf-task-actions"><Button onClick={() => orderTarget(order.id, order.displayNo)}>进入本单完整详情</Button><Button variant="secondary" onClick={() => void copy(order)}>复制本单核对摘要</Button></div></div>)}{!detail.supervision.orders.items?.length && <p>当前授权范围没有匹配订单；不能推定全平台没有历史订单。</p>}<p className="wf-hint">当前范围{detail.supervision.orders.total}条，显示最近5条；订单读取不等群、利润或资金权限。</p></>}</section></div>}
 {section === "archive" && (version ? <SupplyDetailPane detail={{ ...detail, version } as Detail} loading={detailBusy} tab={archiveTab} onTabChange={setArchiveTab} versionId={versionId} onSelectVersion={id => { if (busy || intent?.unknown)
            return; if (reasonIsDirty(reason) && !window.confirm("切换资料将丢弃未提交说明，继续吗？"))
            return; setIntent(undefined); setReason(""); setChecked(false); setVersionId(id); const query: Record<string, string> = { ...initialQuery, context: "archive" }; if (id)
            query.versionId = id;
        else
            delete query.versionId; onQueryChange(query); }} canDuplicate={can("supply.duplicate.review")} canReviewMedia={can("supply.review.decide")} queueItems={relatedItems} related={related} onRelatedChange={setRelated} busy={busy || readFailed} reasonReady={reason.trim().length >= 2} onRecordDuplicate={() => begin("duplicate")} onQuarantine={id => begin("media", id, "QUARANTINE")} onRestore={id => begin("media", id, "APPROVE")} onZoom={setZoom} releaseGeneration={null} onRefresh={() => void reread()} refreshing={detailBusy} actions={version.reviewState === "SUBMITTED" && can("supply.review.decide") && !historical ? <><Button variant="secondary" disabled={busy || readFailed} onClick={() => begin("APPROVE")}>通过历史审核</Button><Button variant="secondary" disabled={busy || readFailed} onClick={() => begin("REJECT")}>退回历史审核</Button></> : undefined}/> : <p className="wf-empty">本账号尚无资料版本，其他对象事实仍可核对。</p>)}
 <footer className="wf-handoff"><details><summary>最近选择的核对摘要与手动交接</summary><pre>{manualSummary ?? handoff}</pre><Button variant="secondary" onClick={() => void copy()}><Copy size={15}/>复制业务核对摘要</Button></details><Button variant="ghost" onClick={back} disabled={busy || intent?.unknown}>回原工作视图继续查看</Button>{copyNotice && <p role="status">{copyNotice}</p>}</footer></>}
 {intent && <SupplyActionDialog title={intent.title} objectLabel={intent.objectLabel} imageSrc={intent.assetId ? mediaContentUrl(intent.assetId) : undefined} stale={stale && !intent.unknown} unknown={Boolean(intent.unknown)} onRecheck={() => { if (busy || intent.unknown)
        return; setIntent(undefined); setChecked(false); setFeedback(undefined); void reread(); }} consequence={intent.consequence} conditions={intent.conditions} reason={String(intent.request?.body.reason ?? reason)} onReasonChange={value => { if (!intent.request)
        setReason(value); }} onConfirm={() => void confirm()} onClose={() => { if (!busy && !intent.unknown) {
        setIntent(undefined);
        setFeedback(undefined);
    } }} busy={busy} conflict={Boolean(intent.invalid)} feedback={feedback} onRefresh={() => void reread()}/>}
 {zoom && <Lightbox {...zoom} onClose={closeZoom}/>}
 </section>;
}
