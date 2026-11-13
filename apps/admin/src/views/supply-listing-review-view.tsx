import { useCallback, useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { EntityPreviewEnabledContext } from "@/components/admin-preview/entity-preview-trigger";
import { useIsMobile } from "../hooks/use-mobile";
import { SupplyActionDialog, type ActionFeedback } from "./supply-review/action-bar";
import { useSavedViews } from "./supply-accounts/account-list-parts";
import { LOGIN_METHOD_OPTIONS, lookupNeedsDirectory, suggestKind } from "./supply-accounts/account-list-model";
import { ACCOUNT_BUSINESS_STATES, knownSupplyLink, mediaContentUrl, orderHandoff, reasonIsDirty, restrictionConditions, supplyFactText, supplyObjectLabel, type SupplyLinkedOrder, type SupplyQueryKind, type SupplyWorkDetail, type SupplyWorkItem, type SupplyWorkPage, type SupplyWorkView, type Version, type ZoomTarget } from "./supply-review/model";
import { ListingVersionChoiceDialog, ListingZoomDialog } from "./supply-listing-review-dialogs";
import { SupplyListingDetail, sections } from "./supply-listing-review-detail";
import { activeView, SupplyListingList, views, type Filter } from "./supply-listing-review-list";
type Snapshot = Extract<SessionSnapshot, {
    authenticated: true;
}>;
export type Props = {
    snapshot: Snapshot;
    refreshNonce: number;
    onDirtyChange: (dirty: boolean) => void;
    initialAccountId?: string;
    initialQuery: Record<string, string>;
    onOpenPath: (path: string, title?: string) => void;
    onQueryChange: (query: Record<string, string>) => void;
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
const lookup = [["account", "账号业务编号 / 稳定ID"], ["legacy", "旧来源编号"], ["owner", "号主稳定ID / 旧用户ID"], ["nickname", "号主昵称"], ["link", "本站账号/订单链接"], ["order", "关联订单号"]] as const;
const parseCursorHistory = (value: string | undefined): string[] => { try {
    const result = JSON.parse(value ?? "[]");
    return Array.isArray(result) && result.length <= 32 && result.every(c => typeof c === "string" && c.length <= 2048 && (c === "" || /^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]{43}$/.test(c))) ? result : [];
}
catch {
    return [];
} };
const emptyFilter: Filter = { view: "all", kind: "account", q: "", gameId: "", status: "", eligibility: "", source: "", haffMin: "", haffMax: "", depositMin: "", depositMax: "", loginMethod: "", limit: "20", cursor: "" };
const intFilter = (value: string | undefined) => value && /^(0|[1-9]\d{0,29})$/.test(value) ? value : "";
const initialFilter = (query: Record<string, string>): Filter => ({
    ...emptyFilter,
    view: views.some(v => v[0] === query.view) ? query.view as SupplyWorkView : "all",
    kind: lookup.some(k => k[0] === query.queryKind) ? query.queryKind as SupplyQueryKind : "account",
    q: query.q ?? "",
    gameId: query.gameId ?? "",
    status: ACCOUNT_BUSINESS_STATES.find(state => state.value === query.status)?.value ?? "",
    eligibility: ["ELIGIBLE", "BLOCKED", "UNKNOWN"].includes(query.eligibility ?? "") ? query.eligibility! : "",
    source: ["NEW", "LEGACY"].includes(query.source ?? "") ? query.source! : "",
    haffMin: intFilter(query.haffMin), haffMax: intFilter(query.haffMax), depositMin: intFilter(query.depositMin), depositMax: intFilter(query.depositMax),
    loginMethod: LOGIN_METHOD_OPTIONS.some(option => option.code === query.loginMethod) ? query.loginMethod! : "",
    limit: ["5", "20", "50"].includes(query.limit ?? "") ? query.limit! : "20",
    cursor: query.view && !views.some(v => v[0] === query.view) ? "" : query.cursor ?? "",
});
const filterParams = (filter: Filter) => ({
    ...(filter.gameId ? { gameId: filter.gameId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.eligibility ? { eligibility: filter.eligibility } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.haffMin ? { haffMin: filter.haffMin } : {}),
    ...(filter.haffMax ? { haffMax: filter.haffMax } : {}),
    ...(filter.depositMin ? { depositMin: filter.depositMin } : {}),
    ...(filter.depositMax ? { depositMax: filter.depositMax } : {}),
    ...(filter.loginMethod ? { loginMethod: filter.loginMethod } : {}),
});
const fail = (error: unknown) => error instanceof AdminApiError && error.status === 409 ? "查询或确认上下文已变化，请回到首页或重新核对。" : friendlyError(error);
export function SupplyListingReviewView(props: Props) {
    if (!hasPermission(props.snapshot, "supply.review.read") && !(props.initialAccountId && hasPermission(props.snapshot, "supply.rental_account.read")))
        return <p className="p-6 text-sm text-muted-foreground">没有出租账号读取权限，未读取对象数据。</p>;
    const previewEnabled = !props.snapshot.session.locked && props.snapshot.security.status === "ACTIVE" && !props.snapshot.security.passwordChangeRequired;
    return <EntityPreviewEnabledContext.Provider value={previewEnabled}><SupplyWork key={[props.snapshot.adminUserId, props.snapshot.session.id, props.snapshot.security.isBoss, [...props.snapshot.permissions].sort().join(","), props.initialAccountId ?? "list"].join("|")} {...props}/></EntityPreviewEnabledContext.Provider>;
}
function SupplyWork({ snapshot, refreshNonce, onDirtyChange, initialAccountId, initialQuery, onOpenPath, onQueryChange }: Props) {
    const mobile = useIsMobile();
    const [filtersOpen, setFiltersOpen] = useState(false);
    const identity = snapshot.adminUserId + "|" + snapshot.session.id, can = (permission: string) => hasPermission(snapshot, permission), saved = positions.get(identity);
    const [filter, setFilter] = useState<Filter>(() => saved?.filter ? { ...emptyFilter, ...saved.filter, view: activeView(saved.filter.view), cursor: activeView(saved.filter.view) === saved.filter.view ? saved.filter.cursor : "" } : initialFilter(initialQuery));
    const [draftKind, setDraftKind] = useState<SupplyQueryKind>(saved?.filter.kind ?? filter.kind), [draftQ, setDraftQ] = useState(saved?.filter.q ?? filter.q);
    const savedViewIsActive = saved?.filter ? activeView(saved.filter.view) === saved.filter.view : !initialQuery.view || views.some(([value]) => value === initialQuery.view);
    const [stack, setStack] = useState<string[]>(savedViewIsActive ? saved?.stack ?? parseCursorHistory(initialQuery.supplyCursorHistory) : []), [page, setPage] = useState<SupplyWorkPage>(), [listBusy, setListBusy] = useState(!initialAccountId), [listError, setListError] = useState<string>(), [listNotice, setListNotice] = useState<string>(), [queryError, setQueryError] = useState<string>();
    const origins = useRef<SupplyWorkPage["stationOrigins"] | undefined>(savedViewIsActive ? saved?.stationOrigins : undefined);
    const [detail, setDetail] = useState<SupplyWorkDetail>(), [detailBusy, setDetailBusy] = useState(Boolean(initialAccountId)), [detailError, setDetailError] = useState<string>(), [versionId, setVersionId] = useState<string | null>(initialQuery.versionId ?? null), [publicDraftAccount, setPublicDraftAccount] = useState<string | null>(null);
    const [selectedSection, setSection] = useState<string>(initialQuery.context === "changes" ? "records" : sections.some(s => s[0] === initialQuery.context) ? initialQuery.context! : "situation");
    const [reason, setReason] = useState(""), [checked, setChecked] = useState(false), [intent, setIntent] = useState<Intent>(), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<ActionFeedback>(), [readFailed, setReadFailed] = useState(false);
    const [versionChoice, setVersionChoice] = useState<{ id: string | null }>();
    const [zoom, setZoom] = useState<ZoomTarget>(), [copyNotice, setCopyNotice] = useState(""), [manualSummary, setManualSummary] = useState<string>();
    const [broaderMatch, setBroaderMatch] = useState<boolean>();
    const quickOrigin = useRef<HTMLElement | null>(null);
    const zoomOrigin = useRef<HTMLElement | null>(null), zoomClose = useRef<HTMLButtonElement>(null);
    const [quick, setQuick] = useState<string | null>(null), savedViews = useSavedViews(snapshot.adminUserId);
    const listSeq = useRef(0), detailSeq = useRef(0), alive = useRef(true), actionLock = useRef(false), viewport = useRef<HTMLDivElement>(null);
    const version = detail?.version, historical = detail?.supervision.historical ?? false;
    const managementReady = can("supply.review.read") && detail?.supervision.managementAccess !== "DENIED";
    const section = managementReady || selectedSection === "orders" && can("order.read") ? selectedSection : "situation";
    const publicDefault = detail && !versionId && publicDraftAccount !== detail.account.id && !historical && detail.supervision.facts.publicBasis && version && detail.supervision.facts.publicBasis.id !== version.id ? detail.supervision.facts.publicBasis : null;
    const contextSwitchBlocked = busy || detailBusy || Boolean(intent);
    const switchVersionContext = (useDraft: boolean) => { if (!detail || contextSwitchBlocked || actionLock.current) return; setPublicDraftAccount(useDraft ? detail.account.id : null); };
    const incomingSection = initialQuery.context === "changes" ? "records" : initialQuery.context;
    const incomingContext = sections.some(item => item[0] === incomingSection) && (managementReady || initialQuery.context === "orders" && can("order.read")) ? incomingSection! : "situation";
    const incomingVersion = initialQuery.versionId ?? null;
    const incomingSelection = useRef(JSON.stringify([incomingContext, incomingVersion]));
    useEffect(() => {
        const key = JSON.stringify([incomingContext, incomingVersion]);
        if (!initialAccountId || key === incomingSelection.current) return;
        incomingSelection.current = key;
        if (incomingContext === section && incomingVersion === versionId) return;
        if (busy || intent || actionLock.current || reasonIsDirty(reason)) {
            const query: Record<string, string> = { ...initialQuery, context: section };
            if (versionId) query.versionId = versionId; else delete query.versionId;
            onQueryChange(query);
            if (!intent) setFeedback({ kind: "error", message: "当前核对说明尚未提交，已保留原资料和分区；请完成或清空说明后再切换。" });
            return;
        }
        setSection(incomingContext); setVersionId(incomingVersion); setPublicDraftAccount(null);
        setChecked(false); setVersionChoice(undefined); setZoom(undefined);
    }, [incomingContext, incomingVersion, initialAccountId]);
    useEffect(() => {
        if (detail?.supervision.managementAccess !== "DENIED") return;
        setIntent(undefined); setReason(""); setChecked(false); setVersionChoice(undefined); setZoom(undefined); setFeedback(undefined); setManualSummary(undefined); setPublicDraftAccount(null);
    }, [detail?.supervision.managementAccess]);
    const closeZoom = useCallback(() => { setZoom(undefined); requestAnimationFrame(() => (zoomOrigin.current?.isConnected ? zoomOrigin.current : document.getElementById("supply-detail-title"))?.focus({ preventScroll: true })); }, []);
    const openZoom = (target: ZoomTarget, trigger?: HTMLElement) => { zoomOrigin.current = trigger ?? document.activeElement as HTMLElement | null; setZoom(target); };
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
        const params = new URLSearchParams({ queryVersion: "3", view: filter.view, queryKind: kind, q, ...filterParams(filter), limit: filter.limit, ...(filter.cursor ? { cursor: filter.cursor } : {}) });
        const value = await adminRequest<SupplyWorkPage>("/supply/listing-reviews?" + params, undefined, "GET", {}, signal);
        if (!alive.current || seq !== listSeq.current || signal?.aborted)
            return;
        origins.current = value.stationOrigins;
        setPage(value);
        if (value.items.length === 0 && filter.view !== "all" && q.trim() && !filter.cursor) {
            void (async () => {
                try {
                    const probe = await adminRequest<SupplyWorkPage>("/supply/listing-reviews?" + new URLSearchParams({ queryVersion: "3", view: "all", queryKind: kind, q, ...filterParams(filter), limit: "5" }), undefined, "GET", {}, signal);
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
        return; const controller = new AbortController(); const timeout = AbortSignal.timeout(8000); const signal = AbortSignal.any([controller.signal, timeout]); setListBusy(true); setListError(undefined); setPage(undefined); void loadList(signal).then(value => { if (controller.signal.aborted)
        return; if (timeout.aborted) { setListError("读取超时，请缩小条件后重试"); return; } if (!value)
        return;
        if (filter.cursor && typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= 0 && !value.items.length && stack.length * Number(filter.limit) >= value.total) {
        positions.delete(identity);
        setListNotice("账号列表已变化，已回到第1页；筛选条件已保留。");
        setStack([]);
        setFilter(current => ({ ...current, cursor: "" }));
        return;
    }
        const prior = positions.get(identity); if (prior?.contextKey && prior.contextKey !== value.contextKey) {
        positions.delete(identity);
        setStack([]);
        setFilter({ ...emptyFilter });
        return;
    } requestAnimationFrame(() => { const scroller = viewport.current?.closest(".workspace-page"); if (scroller && prior)
        scroller.scrollTop = prior.scroll; window.scrollTo(0, prior?.windowScroll ?? 0); (document.getElementById(prior?.focus ?? "") ?? document.getElementById("supply-work-title"))?.focus({ preventScroll: true }); }); }).catch(error => { if (controller.signal.aborted)
        return; if (timeout.aborted || (error instanceof AdminApiError && error.status === 504)) {
        setListError("读取超时，请缩小条件后重试");
        return;
    }
    if (error instanceof AdminApiError && error.code === "EVIDENCE_UNAVAILABLE") {
        setListError("筛选范围过大，暂不能完整核对；已保留筛选条件，请缩小条件后重试。");
        return;
    }
    if (error instanceof AdminApiError && error.status === 409 && (filter.cursor || stack.length)) {
        setListError(undefined);
        setListNotice("查询上下文已变化，已重新从第1页读取；筛选条件已保留。");
        setStack([]);
        setFilter(current => ({ ...current, cursor: "" }));
        return;
    }
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
    useEffect(() => { if (initialAccountId)
        return; onQueryChange({ view: filter.view, queryKind: filter.kind, ...filterParams(filter), limit: filter.limit, cursor: filter.cursor, supplyCursorHistory: JSON.stringify(stack) }); }, [filter, stack, initialAccountId]);
    const remember = (focus: string) => positions.set(identity, { filter, stack, scroll: viewport.current?.closest(".workspace-page")?.scrollTop ?? 0, windowScroll: window.scrollY, focus, contextKey: page?.contextKey ?? saved?.contextKey, stationOrigins: origins.current });
    const open = (id: string, title: string, context: string) => { remember("supply-open-" + id); onOpenPath("/supply/reviews/" + encodeURIComponent(id) + "?context=" + context, title); };
    const back = () => onOpenPath("/supply/reviews");
    const goSection = (value: string) => { if (intent?.unknown || busy || !managementReady && value !== "situation" && !(value === "orders" && can("order.read")))
        return; setSection(value); onQueryChange({ ...initialQuery, context: value, ...(versionId ? { versionId } : {}) }); };
    const userTarget = () => { if (!detail || detail.supervision.ownerLink.state !== "READY")
        return; openOwnerPath(detail.account.owner_user_id, detail.account.id, section, detail.ownerName); };
    /** 行内号主入口：只信当前行的 ownerLink 投影，不借用详情状态、不默认读全目录。 */
    const rowOwnerTarget = (row: SupplyWorkItem) => { if (row.ownerLink?.state !== "READY")
        return; openOwnerPath(row.ownerId, row.accountId, "situation", row.ownerName); };
    const openOwnerPath = (userId: string, fromSupplyId: string, context: string, title: string) => onOpenPath("/users/" + encodeURIComponent(userId) + "?" + new URLSearchParams({ fromSupplyId, fromSupplyContext: context, ...(versionId ? { fromSupplyVersionId: versionId } : {}) }), title);
    const orderTarget = (id: string, title: string) => { if (!detail || !can("order.read"))
        return; onOpenPath("/orders/" + encodeURIComponent(id) + "?" + new URLSearchParams({ fromSupplyId: detail.account.id, fromSupplyContext: section, ...(versionId ? { fromSupplyVersionId: versionId } : {}) }), title); };
    const summary = detail ? supplyFactText(detail.supervision.facts) : null, objectLabel = detail ? supplyObjectLabel({ id: detail.account.id, displayNo: detail.account.display_no, facts: detail.supervision.facts }) : "";
    const handoff = detail ? [objectLabel, "当前资料：" + (detail.version ? "已读取" : "未提供"), "当前号主：" + detail.ownerName + " · " + detail.account.owner_user_id, summary!.display + "；" + summary!.newOrders, summary!.reason, "核对说明：" + (reason || "尚未填写"), "既有订单按原主体/资料单独核对。"].join("\n") : "";
    const copy = async (order?: SupplyLinkedOrder) => { if (!detail || order && (!can("order.read") || detail.supervision.orders.state !== "READY")) return; const text = order ? orderHandoff(detail, order, handoff) : handoff; setManualSummary(text); try {
        await navigator.clipboard.writeText(text);
        setCopyNotice("核对摘要已复制，可沿现有号主或本单客服沟通交接；没有自动发送。");
    }
    catch {
        setCopyNotice("剪贴板不可用，请展开最近选择的摘要后手动复制。");
    } };
    const actionContext = (data: SupplyWorkDetail, assetId?: string) => JSON.stringify({ contextKey: data.contextKey, managementAccess: data.supervision.managementAccess, account: data.account, facts: data.supervision.facts, versionId: data.version?.id, versionRevision: (data.version as Version & {
            revision?: string;
        })?.revision, release: data.version?.releaseId, hash: data.version?.contentHash, historical: data.supervision.historical, media: assetId ? data.version?.declaration.mediaBindings.find(m => m.assetId === assetId) : undefined });
    const begin = (kind: "restriction" | "media" | "APPROVE" | "REJECT", assetId?: string, decision?: "QUARANTINE" | "APPROVE") => {
        if (!managementReady || !detail || detail.supervision.historical || readFailed || actionLock.current || intent?.unknown || !detail.version || publicDefault && (kind === "media" || kind === "APPROVE" || kind === "REJECT"))
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
            consequence = "仅改变运营限制，不自动发布资料。既有订单及其原主体、金额与资料不变。";
        }
        else if (kind === "media") {
            permission = "supply.review.decide";
            const media = v.declaration.mediaBindings.find(m => m.assetId === assetId && m.purpose === "ACCOUNT_DISPLAY");
            if (!media?.byteHash || !media.mediaRevision)
                return;
            path = "/supply/media/" + assetId + "/review";
            body = { decision, accountContext: { accountId: a.id, accountRevision: a.revision, versionId: v.id, assetRevision: media.mediaRevision, byteHash: media.byteHash }, ...(decision === "APPROVE" ? { visibility: "PUBLIC_DISPLAY" } : {}) };
            title = decision === "APPROVE" ? "恢复图片展示" : "屏蔽当前图片";
            success = decision === "APPROVE" ? "图片已恢复展示" : "图片已屏蔽";
            consequence = "仅处置这张账号展示图，版本和图片变化会作废旧确认。其他阻断仍独立核对；既有订单不自动改变。";
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
        const originalReason = a.staff_restricted ? detail.supervision.restrictionHistory.items.find(event => event.restricted === true)?.reason : undefined;
        setIntent({ title, success, consequence: consequence + (kind === "restriction" && originalReason ? " 原限制原因：" + originalReason : ""), conditions: kind === "restriction" ? restrictionConditions(detail) : undefined, permission, path, body, context: actionContext(detail, assetId), assetId, objectLabel });
    };
    const stale = Boolean(intent && (intent.invalid || !detail || intent.context !== actionContext(detail, intent.assetId)));
    const confirm = async () => {
        const current = intent;
        if (!managementReady || !current || !can(current.permission) || !alive.current || actionLock.current || !initialAccountId || !current.unknown && (stale || reason.trim().length < 2))
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
    const changeArchiveVersion = (id: string | null) => { if (busy || intent?.unknown) return; setIntent(undefined); setReason(""); setChecked(false); setVersionId(id); setVersionChoice(undefined); const query: Record<string, string> = { ...initialQuery, context: "situation" }; if (id) query.versionId = id; else delete query.versionId; onQueryChange(query); };
    const submitSearch = (event: React.FormEvent) => { event.preventDefault(); setQueryError(undefined); if (lookupNeedsDirectory(draftKind, draftQ)) {
        setQueryError("手机号请从用户管理按独立权限查找。");
        return;
    } if (draftKind === "link" && (!page || !knownSupplyLink(draftQ.trim(), page.stationOrigins))) {
        setQueryError("不是已知本站账号或订单路径，未读取外部地址。");
        return;
    } if (draftKind === "owner" && suggestKind(draftQ) === "nickname") {
        setQueryError("当前按「号主」查找只接受号主用户 ID 或旧平台 ID；输入看起来像昵称，请切换为「昵称」查找。");
        return;
    } let kind = draftKind, q = draftQ.trim(); if (kind === "link") {
        const parsed = knownSupplyLink(q, page!.stationOrigins)!;
        kind = parsed.kind === "order" ? "order" : "account";
        q = parsed.id;
    } setStack([]); setFilter({ ...filter, kind, q, cursor: "" }); positions.delete(identity); };
    const applyFilter = (patch: Partial<Filter>) => { positions.delete(identity); setStack([]); setQuick(null); setFilter(current => ({ ...current, ...patch, cursor: "" })); setQueryError(undefined); };
    const resetFilters = () => {
        positions.delete(identity);
        setStack([]);
        setQuick(null);
        setDraftKind("account");
        setDraftQ("");
        setQueryError(undefined);
        setListError(undefined);
        setListNotice(undefined);
        setFilter({ ...emptyFilter, limit: filter.limit });
    };
    const reloadList = () => setFilter(current => ({ ...current }));
    if (!initialAccountId) {
        const quickRow = page?.items.find(r => r.id === quick);
        const viewRow = (row: SupplyWorkItem, trigger?: HTMLElement) => { quickOrigin.current = trigger ?? document.getElementById("supply-open-" + row.id); remember("supply-open-" + row.id); setQuick(row.id); };
        const openFull = (row: SupplyWorkItem, context: string) => { setQuick(null); open(row.id, supplyObjectLabel(row), context); };
        return <SupplyListingList viewport={viewport} reloadList={reloadList} filter={filter} positions={positions} identity={identity} setStack={setStack} setQuick={setQuick} setFilter={setFilter} onQueryChange={onQueryChange} mobile={mobile} filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen} submitSearch={submitSearch} resetFilters={resetFilters} draftKind={draftKind} setDraftKind={setDraftKind} draftQ={draftQ} setDraftQ={setDraftQ} listBusy={listBusy} savedViews={savedViews} page={page} applyFilter={applyFilter} queryError={queryError} setQueryError={setQueryError} listNotice={listNotice} listError={listError} broaderMatch={broaderMatch} viewRow={viewRow} rowOwnerTarget={rowOwnerTarget} open={open} quick={quick} stack={stack} quickRow={quickRow} openFull={openFull} can={can} quickOrigin={quickOrigin}/>;
    }
    return <SupplyListingDetail viewport={viewport} managementReady={managementReady} back={back} busy={busy} intent={intent} feedback={feedback} readFailed={readFailed} detailBusy={detailBusy} reread={reread} detailError={detailError} detail={detail} objectLabel={objectLabel} publicDefault={publicDefault} version={version} historical={historical} userTarget={userTarget} goSection={goSection} can={can} section={section} setVersionId={setVersionId} setChecked={setChecked} setReason={setReason} initialQuery={initialQuery} onQueryChange={onQueryChange} contextSwitchBlocked={contextSwitchBlocked} switchVersionContext={switchVersionContext} publicDraftAccount={publicDraftAccount} openZoom={openZoom} begin={begin} reason={reason} setVersionChoice={setVersionChoice} changeArchiveVersion={changeArchiveVersion} versionId={versionId} summary={summary} copy={copy} manualSummary={manualSummary} handoff={handoff} copyNotice={copyNotice} orderTarget={orderTarget} checked={checked} dialogs={<>
 {intent && <SupplyActionDialog title={intent.title} objectLabel={intent.objectLabel} imageSrc={intent.assetId ? mediaContentUrl(intent.assetId) : undefined} stale={stale && !intent.unknown} unknown={Boolean(intent.unknown)} onRecheck={() => { if (busy || intent.unknown)
        return; setIntent(undefined); setChecked(false); setFeedback(undefined); void reread(); }} consequence={intent.consequence} conditions={intent.conditions} reason={String(intent.request?.body.reason ?? reason)} onReasonChange={value => { if (!intent.request)
        setReason(value); }} onConfirm={() => void confirm()} onClose={() => { if (!busy && !intent.unknown) {
        setIntent(undefined);
        setFeedback(undefined);
    } }} busy={busy} conflict={Boolean(intent.invalid)} feedback={feedback} onRefresh={() => void reread()}/>}
      <ListingVersionChoiceDialog versionChoice={versionChoice} setVersionChoice={setVersionChoice} changeArchiveVersion={changeArchiveVersion}/>
      <ListingZoomDialog zoom={zoom} zoomClose={zoomClose} closeZoom={closeZoom}/>
    </>}/>;
}
