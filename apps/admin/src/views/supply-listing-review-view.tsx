import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Copy, Search, RefreshCw, CheckCircle2, TriangleAlert } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { SupplySelect } from "@/components/supply/supply-select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge, InlineStatus } from "@/components/ui/badge";
import { EntityPreviewEnabledContext } from "@/components/admin-preview/entity-preview-trigger";
import { useIsMobile } from "../hooks/use-mobile";
import { primaryReason } from "./supply-accounts/account-list-model";
import { condText } from "./supply-accounts/reason-summary";
import { SupplyActionDialog, type ActionFeedback } from "./supply-review/action-bar";
import { AccountCompleteView, ImportedAccountView, PublicBasisView } from "./supply-review/detail-pane";
import { AccountCards, AccountFees, AccountIdentity, AccountResources, AccountTerms, IdLine, KindHint, KindSelect, MoreFilters, QuickView, ReasonCell, RowActions, RowMenu, SavedViewsMenu, StatusBadge, TimeText, useSavedViews } from "./supply-accounts/account-list-parts";
import { KIND_LABELS, LOGIN_METHOD_OPTIONS, fullShanghaiTime, groupConditions, versionText, rowHaffText, rowQuoteText, rowDepositText, rowFullPayout, rowListingStatus, lookupNeedsDirectory, rowBaseFeeRows, rowCoreAssetsText, rowTermsLines } from "./supply-accounts/account-list-model";
import { ListPagination, ListToolbar, ListToolbarSearch, ListToolbarEnumSelect } from "@/components/admin-list";
import { ConditionCheck, ReasonSummary, type CheckTarget } from "./supply-accounts/reason-summary";
import { ACCOUNT_BUSINESS_STATES, historicalReadSummary, blockerLabel, inventoryRows, knownSupplyLink, mediaContentUrl, mediaReviewLabel, orderHandoff, orderPaymentText, publicBasisVersion, quantityText, reasonIsDirty, restrictionConditions, reviewStateLabel, supplyFactText, supplyObjectLabel, type Detail, type MediaBinding, type QueueItem, type SupplyLinkedOrder, type SupplyWorkDetail, type SupplyWorkItem, type SupplyWorkPage, type SupplyWorkView, type SupplyQueryKind, type Version, type ZoomTarget } from "./supply-review/model";
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
    status: import("./supply-review/model").AccountBusinessState | "";
    eligibility: string;
    source: string;
    haffMin: string;
    haffMax: string;
    depositMin: string;
    depositMax: string;
    loginMethod: string;
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
const sections = [["situation", "账号资料"], ["changes", "审核与图片"], ["orders", "关联订单"], ["records", "操作记录"], ["review", "风险操作"]] as const;
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
    cursor: query.cursor ?? "",
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
/** 详情标题用当前资料的中性资源摘要；原始申报标题只作次级信息，不把旧号顶成账号名。 */
function accountNeutralTitle(version: Version | null | undefined): string {
    if (!version) return "账号资料";
    const haff = version.declaration.inventory.find(item => item.itemId === "haff" || version.presentation.items?.find(entry => entry.id === item.itemId)?.unit === "HAFF_BASE");
    const division = version.declaration.attributes.grading_division;
    const grading = version.attributeDisplay?.grading?.displayName
        ? version.attributeDisplay.grading.displayName + (division === null || division === undefined || division === "" ? "" : " " + String(division))
        : null;
    return [haff ? quantityText(haff.quantity) : null, version.attributeDisplay?.safeBox?.displayName ?? null, grading].filter(Boolean).join(" · ") || "账号资料";
}
export function SupplyListingReviewView(props: Props) {
    if (!hasPermission(props.snapshot, "supply.review.read") && !(props.initialAccountId && hasPermission(props.snapshot, "supply.rental_account.read")))
        return <p className="p-6 text-sm text-muted-foreground">没有账号供给读取权限，未读取对象数据。</p>;
    const previewEnabled = !props.snapshot.session.locked && props.snapshot.security.status === "ACTIVE" && !props.snapshot.security.passwordChangeRequired;
    return <EntityPreviewEnabledContext.Provider value={previewEnabled}><SupplyWork key={[props.snapshot.adminUserId, props.snapshot.session.id, props.snapshot.security.isBoss, [...props.snapshot.permissions].sort().join(","), props.initialAccountId ?? "list"].join("|")} {...props}/></EntityPreviewEnabledContext.Provider>;
}
function SupplyWork({ snapshot, refreshNonce, onDirtyChange, initialAccountId, initialQuery, onOpenPath, onQueryChange }: Props) {
    const mobile = useIsMobile();
    const [filtersOpen, setFiltersOpen] = useState(false);
    const identity = snapshot.adminUserId + "|" + snapshot.session.id, can = (permission: string) => hasPermission(snapshot, permission), saved = positions.get(identity);
    const [filter, setFilter] = useState<Filter>(() => saved?.filter ? { ...emptyFilter, ...saved.filter } : initialFilter(initialQuery));
    const [draftKind, setDraftKind] = useState<SupplyQueryKind>(saved?.filter.kind ?? filter.kind), [draftQ, setDraftQ] = useState(saved?.filter.q ?? filter.q);
    const [stack, setStack] = useState<string[]>(saved?.stack ?? parseCursorHistory(initialQuery.supplyCursorHistory)), [page, setPage] = useState<SupplyWorkPage>(), [listBusy, setListBusy] = useState(!initialAccountId), [listError, setListError] = useState<string>(), [listNotice, setListNotice] = useState<string>(), [queryError, setQueryError] = useState<string>();
    const origins = useRef<SupplyWorkPage["stationOrigins"] | undefined>(saved?.stationOrigins);
    const [detail, setDetail] = useState<SupplyWorkDetail>(), [detailBusy, setDetailBusy] = useState(Boolean(initialAccountId)), [detailError, setDetailError] = useState<string>(), [versionId, setVersionId] = useState<string | null>(initialQuery.versionId ?? null), [publicDraftAccount, setPublicDraftAccount] = useState<string | null>(null);
    const [selectedSection, setSection] = useState<string>(sections.some(s => s[0] === initialQuery.context) ? initialQuery.context! : "situation");
    const [reason, setReason] = useState(""), [checked, setChecked] = useState(false), [intent, setIntent] = useState<Intent>(), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<ActionFeedback>(), [readFailed, setReadFailed] = useState(false);
    const [versionChoice, setVersionChoice] = useState<{ id: string | null }>();
    const [zoom, setZoom] = useState<ZoomTarget>(), [copyNotice, setCopyNotice] = useState(""), [manualSummary, setManualSummary] = useState<string>(), [related, setRelated] = useState(""), [relatedItems, setRelatedItems] = useState<QueueItem[]>([]);
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
    const incomingContext = sections.some(item => item[0] === initialQuery.context) && (managementReady || initialQuery.context === "orders" && can("order.read")) ? initialQuery.context! : "situation";
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
        setChecked(false); setVersionChoice(undefined); setZoom(undefined); setRelated("");
    }, [incomingContext, incomingVersion, initialAccountId]);
    useEffect(() => {
        if (detail?.supervision.managementAccess !== "DENIED") return;
        setIntent(undefined); setReason(""); setChecked(false); setRelatedItems([]); setVersionChoice(undefined); setZoom(undefined); setFeedback(undefined); setManualSummary(undefined); setPublicDraftAccount(null);
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
        return; const controller = new AbortController(); setListBusy(true); setListError(undefined); setPage(undefined); void loadList(controller.signal).then(value => { if (!value || controller.signal.aborted)
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
        return; if (error instanceof AdminApiError && error.code === "EVIDENCE_UNAVAILABLE") {
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
    useEffect(() => { if (!managementReady || section !== "changes" || !detail || !can("supply.duplicate.review")) return; let active = true; void adminRequest<SupplyWorkPage>("/supply/listing-reviews?" + new URLSearchParams({ queryVersion: "3", gameId: detail.account.game_id, limit: "50" })).then(data => { if (!active) return; setRelatedItems(data.items.map(r => ({ id: r.id, game_id: detail.account.game_id, title: r.title, owner_name: r.ownerName, game_name: r.gameName, review_state: r.reviewState ?? "", sequence: r.sequence ?? "", owner_paused: r.facts.ownerPaused, staff_restricted: r.facts.staffRestricted }))); }).catch(() => { if (active) setRelatedItems([]); }); return () => { active = false; }; }, [managementReady, section, detail?.account.id, detail?.account.game_id, can("supply.duplicate.review")]);
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
    const handoff = detail ? [objectLabel, "当前资料 " + versionText(detail.version?.sequence) + " · 修订" + detail.account.revision, "当前号主：" + detail.ownerName + " · " + detail.account.owner_user_id, summary!.display + "；" + summary!.newOrders, summary!.reason, "核对说明：" + (reason || "尚未填写"), "既有订单按原主体/资料单独核对。"].join("\n") : "";
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
    const begin = (kind: "restriction" | "media" | "duplicate" | "APPROVE" | "REJECT", assetId?: string, decision?: "QUARANTINE" | "APPROVE") => {
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
        const originalReason = a.staff_restricted ? detail.supervision.restrictionHistory.items.find(event => event.restricted === true)?.reason : undefined;
        setIntent({ title, success, consequence: consequence + (kind === "restriction" && originalReason ? " 原限制原因：" + originalReason : ""), conditions: kind === "restriction" ? restrictionConditions(detail) : undefined, permission, path, body, context: actionContext(detail, assetId), assetId, objectLabel: objectLabel + " · 第" + v.sequence + "版 · 修订" + a.revision });
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
    const image = (binding: MediaBinding | undefined, caption: string) => binding ? <Button variant="ghost" type="button" className="wf-image wf-review-image h-auto flex-col whitespace-normal p-0" aria-label={"放大核对 " + caption} onClick={event => openZoom({ src: mediaContentUrl(binding.assetId), alt: caption, caption }, event.currentTarget)}><img src={mediaContentUrl(binding.assetId)} alt={caption} loading="lazy"/><span>{caption} · {mediaReviewLabel(binding)} · 放大核对</span></Button> : <p className="wf-hint">未提供对应图片，不能视作证据已核齐。</p>;
    const changeArchiveVersion = (id: string | null) => { if (busy || intent?.unknown) return; setIntent(undefined); setReason(""); setChecked(false); setVersionId(id); setVersionChoice(undefined); const query: Record<string, string> = { ...initialQuery, context: "situation" }; if (id) query.versionId = id; else delete query.versionId; onQueryChange(query); };
    const checkTarget = (code: string): CheckTarget => { const owner = ["OWNER_UNAVAILABLE", "IDENTITY_REQUIRED", "ADULT_REQUIRED", "OWNER_PAUSED"], profile = ["RULE_CHANGED", "QUOTE_REQUIRED", "ACCEPTANCE_REQUIRED", "MEDIA_REQUIRED", "CONFIRMATION_OR_MEDIA_REQUIRED", "CURRENT_VERSION_MISSING", "PUBLICATION_REQUIRED", "ACCOUNT_NOT_PUBLISHABLE", "HISTORICAL_VERSION"];
        if (code === "STAFF_RESTRICTED") return { label: can("supply.restrict") ? "复核限制" : "查看记录", go: () => goSection(can("supply.restrict") ? "review" : "records") };
        if (owner.includes(code)) return detail?.supervision.ownerLink.state === "READY" ? { label: "查看号主", go: userTarget } : null;
        if (profile.includes(code)) return { label: "查看资料", go: () => goSection("changes") };
        if (code === "OCCUPIED" || code === "OCCUPANCY_UNKNOWN") return { label: "查看订单", go: () => goSection("orders") };
        return { label: "查看账号资料", go: () => goSection("situation") }; };
    const emptyState = <div className="p-8 text-center"><h2 className="text-base font-semibold">当前范围没有匹配账号</h2><p className="mt-1 text-muted-foreground">查询与视图已保留；不代表范围外或全平台没有账号。{filter.view === "restricted" ? "已解除的账号不再匹配运营限制视图，可返回全部账号核对剩余问题。" : ""}</p>{broaderMatch ? <p className="wf-hint">同一线索在“全部账号”视图下有匹配，被当前“{views.find(v => v[0] === filter.view)?.[1]}”视图条件过滤；可切换视图核对。</p> : null}</div>;
    const submitSearch = (event: React.FormEvent) => { event.preventDefault(); setQueryError(undefined); if (lookupNeedsDirectory(draftKind, draftQ)) {
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
    if (!initialAccountId) {
        const quickRow = page?.items.find(r => r.id === quick);
        const viewRow = (row: SupplyWorkItem, trigger?: HTMLElement) => { quickOrigin.current = trigger ?? document.getElementById("supply-open-" + row.id); remember("supply-open-" + row.id); setQuick(row.id); };
        const openFull = (row: SupplyWorkItem, context: string) => { setQuick(null); open(row.id, supplyObjectLabel(row), context); };
        return <div className="sa-page text-sm" ref={viewport}><header className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h1 id="supply-work-title" tabIndex={-1} className="text-2xl leading-9 font-semibold outline-none">账号供给</h1><p className="mt-0.5 text-muted-foreground">管理账号资料与接单条件</p></div><div className="text-right"><Button variant="outline" size="lg" onClick={() => setFilter({ ...filter })}><RefreshCw size={15}/>刷新列表</Button><p className="mt-2 text-xs text-muted-foreground">仅展示当前授权范围</p></div></header>
 <Tabs value={filter.view} onValueChange={value => { const v = value as SupplyWorkView; positions.delete(identity); setStack([]); setQuick(null); setFilter({ ...filter, view: v, cursor: "" }); onQueryChange({ view: v }); }} className="mb-4"><TabsList aria-label="供给工作视图" className="overflow-x-auto gap-5 [&>button]:shrink-0 [&>button]:whitespace-nowrap [&>button]:px-1">{views.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList></Tabs>
 <ListToolbar noValidate className="sa-search" onSubmit={submitSearch} onReset={resetFilters}>
   <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 md:min-w-[380px]">
     <KindSelect kind={draftKind} onKind={setDraftKind}/>
     <ListToolbarSearch value={draftQ} onChange={setDraftQ} ariaLabel="业务线索" placeholder={"输入" + KIND_LABELS[draftKind] + "查找"} />
     <Button type="submit" size="lg" className="px-4" disabled={listBusy}>查找</Button>
     <SavedViewsMenu saved={savedViews} current={{ view: filter.view, kind: draftKind, q: draftQ.trim(), gameId: filter.gameId, status: filter.status, eligibility: filter.eligibility }} onLoad={v => { positions.delete(identity); setStack([]); setDraftKind(v.kind); setDraftQ(v.q); setFilter({ ...filter, view: v.view, kind: v.kind, q: v.q, gameId: v.gameId, status: v.status ?? "", eligibility: v.eligibility ?? "", cursor: "" }); }}/>
     {draftQ && <Button variant="ghost" type="button" size="lg" className="text-xs text-muted-foreground" onClick={() => { positions.delete(identity); setDraftQ(""); setStack([]); setFilter({ ...filter, q: "", cursor: "" }); setQueryError(undefined); }}>清除线索</Button>}
   </div>
   <Collapsible open={!mobile || filtersOpen} onOpenChange={setFiltersOpen} className="w-full"><CollapsibleTrigger render={<Button type="button" variant="outline" className="md:hidden"/>}>筛选{[filter.gameId,filter.status,filter.eligibility,filter.source,filter.loginMethod,filter.haffMin||filter.haffMax,filter.depositMin||filter.depositMax].filter(Boolean).length ? "（"+[filter.gameId,filter.status,filter.eligibility,filter.source,filter.loginMethod,filter.haffMin||filter.haffMax,filter.depositMin||filter.depositMax].filter(Boolean).length+"）" : ""}</CollapsibleTrigger><CollapsibleContent className="pt-3 md:pt-0"><div className="flex flex-wrap items-center gap-2">
     {page?.games?.length ? <ListToolbarEnumSelect label="游戏" value={filter.gameId} onChange={gameId => applyFilter({ gameId })} options={page.games.map(g => [g.id, g.name] as [string, string])} allLabel="当前范围全部游戏" /> : null}
     <ListToolbarEnumSelect label="账号状态" value={filter.status} onChange={status => applyFilter({ status: status as Filter["status"], eligibility: "" })} options={ACCOUNT_BUSINESS_STATES.map(state => [state.value, state.label] as [string, string])} allLabel="全部状态" />
     <ListToolbarEnumSelect label="账号来源" value={filter.source} onChange={source => applyFilter({ source })} options={[["NEW", "新平台"], ["LEGACY", "旧平台迁入"]]} allLabel="全部来源" />
     <MoreFilters values={filter} loginOptions={page?.filterOptions?.loginMethods?.length ? page.filterOptions.loginMethods : LOGIN_METHOD_OPTIONS} onChange={patch => applyFilter(patch)} />
     <Button type="button" variant="ghost" size="lg" className="text-xs text-muted-foreground" disabled={listBusy} onClick={resetFilters}>重置筛选</Button>
   </div></CollapsibleContent></Collapsible>
 </ListToolbar>
 {filter.eligibility ? <p className="mt-2 text-xs text-muted-foreground" role="status">沿用旧接单资格条件：{filter.eligibility === "ELIGIBLE" ? "可接新单" : filter.eligibility === "BLOCKED" ? "不可接新单" : "资格待核"}<Button type="button" variant="link" size="xs" className="ml-2 px-0" onClick={() => applyFilter({ eligibility: "" })}>清除旧资格条件</Button></p> : null}
 <KindHint q={draftQ} kind={draftKind} onKind={setDraftKind}/>
 {savedViews.notice && <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-400">{savedViews.notice} <Button variant="link" type="button" className="underline" onClick={savedViews.dismiss}>知道了</Button></p>}
 {queryError && <p role="alert" className="mt-1 text-xs text-destructive">{queryError}</p>}{filter.kind === "nickname" && filter.q && <p className="mt-1 text-xs text-muted-foreground">昵称可能重名，请按编号核对主体。</p>}
 <div className="mt-3">
   {listNotice ? <p role="status" className="mb-2 text-xs text-muted-foreground">{listNotice}</p> : null}
   {listError ? (
     <Alert variant="destructive">
       <TriangleAlert aria-hidden />
       <AlertTitle>本次列表未读到</AlertTitle>
       <AlertDescription>{listError}</AlertDescription>
       <AlertAction><Button onClick={() => { positions.delete(identity); setStack([]); setFilter({ ...filter, cursor: "" }); }}>回首页重读</Button></AlertAction>
     </Alert>
   ) : listBusy ? (
     <div className="space-y-2 py-2" aria-busy="true">
       <p className="sr-only">正在读取账号供给…</p>
       {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full"/>)}
     </div>
   ) : (
     <>
       <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
         <Table className="sa-table w-full min-w-[1040px] text-sm">
           <TableHeader>
             <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
               <TableHead className="min-w-[240px] px-3 py-2 text-xs font-normal text-muted-foreground">账号 / 号主</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">核心资源</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">出租条件</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground" title="哈夫币租金与物资预付组成资源费，押金另列；租客实际费用以本人报价为准">基础报价</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">业务状态</TableHead>
               <TableHead className="px-3 py-2 text-xs font-normal text-muted-foreground">更新时间</TableHead>
               <TableHead className="w-24 px-3 py-2 text-xs font-normal text-muted-foreground">操作</TableHead>
             </TableRow>
           </TableHeader>
           <TableBody>
             {page?.items.map(row => {
               const label = supplyObjectLabel(row);
               const context = filter.view === "changes" ? "changes" : filter.view === "orders" ? "orders" : "situation";
               const terms = rowTermsLines(row), fees = rowBaseFeeRows(row);
               return (
                 <TableRow
                   key={row.id}
                   id={"supply-open-" + row.id}
                   tabIndex={0}
                   aria-label={"快速查看 " + label}
                   onClick={e => viewRow(row, e.currentTarget)}
                   onKeyDown={e => {
                     if (e.target !== e.currentTarget) return;
                     if (e.key === "Enter" || e.key === " ") {
                       e.preventDefault();
                       viewRow(row, e.currentTarget);
                     }
                   }}
                   className={"cursor-pointer border-b border-border align-middle outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:shadow-[inset_3px_0_0_var(--ring)] " + (quick === row.id ? "bg-muted/60 " : "")}
                 >
                   <TableCell className="max-w-[300px] px-3 py-2.5 whitespace-normal"><AccountIdentity row={row} onOpenOwner={rowOwnerTarget}/></TableCell>
                   <TableCell className="max-w-[310px] px-3 py-3 whitespace-normal text-xs"><AccountResources row={row}/></TableCell>
                   <TableCell className="px-3 py-2.5 whitespace-normal text-xs text-muted-foreground">
                     <AccountTerms row={row}/>
                   </TableCell>
                   <TableCell className="px-3 py-2.5 whitespace-normal text-xs tabular-nums">
                     <AccountFees row={row}/>
                   </TableCell>
                   <TableCell className="px-3 py-2.5 whitespace-normal">
                     <StatusBadge facts={row.facts} reviewState={row.reviewState}/>
                     <div className="mt-1 text-xs"><ReasonCell facts={row.facts} onMore={() => viewRow(row)}/></div>
                   </TableCell>
                   <TableCell className="px-3 py-2.5 text-muted-foreground">
                     {row.accountUpdatedAt ? <TimeText iso={row.accountUpdatedAt} label="账号更新时间"/> : <span className="text-xs">未提供</span>}
                   </TableCell>
                   <TableCell className="w-24 px-2 py-2">
                     <RowActions row={row} onFull={() => open(row.id, label, context)}/>
                   </TableCell>
                 </TableRow>
               );
             })}
             {!page?.items.length && (
               <TableRow>
                 <TableCell colSpan={7}>{emptyState}</TableCell>
               </TableRow>
             )}
           </TableBody>
         </Table>
       </div>
       <div className="md:hidden">
         {page?.items.length ? <AccountCards items={page.items} onView={viewRow} onOpenOwner={rowOwnerTarget}/> : emptyState}
       </div>
     </>
   )}
 </div>
 <footer className="mt-3">
   <ListPagination mode="cursor" page={stack.length + 1} total={page?.total ?? undefined} pageSize={Number(filter.limit)} loadedCount={page?.items.length ?? 0} loading={listBusy} pageSizeOptions={[5, 20, 50]} itemLabel="个账号"
     hasPrevious={stack.length > 0} hasNext={Boolean(page?.nextCursor)}
     onPageSizeChange={v => { positions.delete(identity); setStack([]); setFilter({ ...filter, limit: String(v), cursor: "" }); }}
     onPrevious={() => { positions.delete(identity); const prior = [...stack], cursor = prior.pop()!; setStack(prior); setFilter({ ...filter, cursor }); }}
     onNext={() => { positions.delete(identity); setStack([...stack, filter.cursor]); setFilter({ ...filter, cursor: page!.nextCursor! }); }}/>
 </footer>
 {quickRow && (
   <QuickView
     row={quickRow}
     canRead={can("supply.review.read")}
     onClose={() => {
       setQuick(null);
       requestAnimationFrame(() => (quickOrigin.current?.isConnected ? quickOrigin.current : document.getElementById("supply-work-title"))?.focus());
     }}
     onOpenFull={context => openFull(quickRow, context)}
   />
 )}

 {/* 批量下架/退还保证金与单账号上/下架、退款都没有正式合同，不提供假处置入口。 */}
</div>;
    }
    const original = detail?.supervision.restrictionHistory.items.find(e => e.restricted === true), currentMedia = version?.declaration.mediaBindings.find(m => m.purpose === "ACCOUNT_DISPLAY" && (!initialQuery.assetId || m.assetId === initialQuery.assetId)), previous = detail?.supervision.previousVersion, previousMedia = detail?.supervision.originalRestrictionVersion?.declaration.mediaBindings.find(m => m.purpose === "ACCOUNT_DISPLAY"), restricted = detail?.account.staff_restricted ?? false;
    return <section className="wf-detail" ref={viewport}>{managementReady ? <div className="mb-3"><Button variant="ghost" className="-ml-2.5" onClick={back} disabled={busy || intent?.unknown}><ArrowLeft size={15}/>返回账号供给</Button></div> : null}
 {feedback && !intent && <Alert tabIndex={-1} variant={feedback.kind === "error" ? "destructive" : "success"} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.kind === "error" ? <TriangleAlert aria-hidden /> : <CheckCircle2 aria-hidden />}<AlertTitle>{feedback.message}</AlertTitle>{readFailed ? <AlertDescription>当前详情未读到，只重读本次结果。</AlertDescription> : null}{readFailed ? <AlertAction><Button variant="outline" disabled={detailBusy} onClick={() => void reread()}>只重读本次结果</Button></AlertAction> : null}</Alert>}
 {detailBusy && !detail ? <div className="wf-empty" aria-busy="true">正在读取账号详情…</div> : detailError && !detail ? <Alert variant="destructive"><TriangleAlert aria-hidden /><AlertTitle>本次详情未读到</AlertTitle><AlertDescription>{detailError}</AlertDescription><AlertAction><Button onClick={() => void reread()} disabled={busy}>重读当前账号</Button></AlertAction></Alert> : detail && <>
 <header className="mb-4 flex flex-wrap items-start justify-between gap-4 text-sm"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 id="supply-detail-title" data-version-id={publicDefault?.id ?? version?.id} tabIndex={-1} className="text-xl font-semibold tabular-nums outline-none">{objectLabel}</h1><StatusBadge facts={detail.supervision.facts} reviewState={historical ? null : version?.reviewState}/>{detail.supervision.facts.sources.length || detail.supervision.facts.historicalRead ? <Badge variant="outline">旧平台迁入</Badge> : null}</div><p className="mt-2 text-sm text-muted-foreground">{accountNeutralTitle(publicDefault ? publicBasisVersion(publicDefault) : version)}<span className="mx-2">·</span>号主：{detail.ownerName}</p></div><div className="flex flex-wrap gap-2">{can("order.read") ? <Button variant="outline" onClick={() => goSection("orders")}>查看关联订单</Button> : null}{detail.supervision.ownerLink.state === "READY" && <Button variant="outline" onClick={userTarget}>查看号主资料</Button>}<Button variant="ghost" size="icon-sm" aria-label="刷新详情" disabled={detailBusy || busy} onClick={() => void reread()}><RefreshCw className="size-4"/></Button></div></header>
 {historical && <div className="wf-notice" role="status"><p>正在查看历史版本，所有处置关闭。业务情况仍指当前账号。</p><Button variant="outline" onClick={() => { setVersionId(null); setChecked(false); setReason(""); const query: Record<string, string> = { ...initialQuery, context: section }; delete query.versionId; onQueryChange(query); }}>回到当前资料</Button></div>}

 {section === "review" ? <div className="mb-4 flex items-center justify-between border-b pb-2 text-sm"><span className="font-semibold">风险操作 · {restricted ? "复核已有限制" : "新增运营限制"}</span><Button variant="ghost" size="sm" disabled={busy || intent?.unknown} onClick={() => goSection("situation")}>返回账号资料</Button></div> : <Tabs value={section} onValueChange={v => goSection(String(v))} className="mb-4"><TabsList aria-label="账号核对分区" className="overflow-x-auto gap-5 [&>button]:shrink-0 [&>button]:px-1">{sections.filter(([key]) => key !== "review" && (managementReady || key === "situation" || key === "orders" && can("order.read"))).map(([key, label]) => <TabsTrigger key={key} value={key}>{label}</TabsTrigger>)}</TabsList></Tabs>}
 {section === "situation" && <div className="grid gap-4 text-sm">
   {managementReady ? (() => { const groups = groupConditions(detail.supervision.facts), count = groups.blocked.length + groups.pending.length, code = primaryReason(detail.supervision.facts).code; return count ? <Collapsible className="border-b border-border pb-3"><CollapsibleTrigger render={<Button variant="ghost" className="h-auto w-full justify-between gap-4 px-0 py-1 text-left"/>}><span className="text-sm font-medium">{code ? condText(code) : "接单条件待核对"}</span><span className="shrink-0 text-xs text-muted-foreground">查看 {count} 项核对内容</span></CollapsibleTrigger><CollapsibleContent keepMounted className="pt-3 data-[closed]:hidden"><ConditionCheck facts={detail.supervision.facts} target={checkTarget}/></CollapsibleContent></Collapsible> : null; })() : <p className="text-xs text-muted-foreground">当前仅可查看账号资料；审核与操作记录无权查看。</p>}
   {publicDefault ? <div className="space-y-3">
     <PublicBasisView basis={publicDefault} showManagement={managementReady}/>
     {managementReady ? <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={contextSwitchBlocked} onClick={() => switchVersionContext(true)}>查看当前草稿</Button></div> : null}
   </div> : version ? <div className="space-y-3">
     <div className="flex flex-wrap gap-2">{publicDraftAccount === detail.account.id && detail.supervision.facts.publicBasis ? <Button variant="outline" disabled={contextSwitchBlocked} onClick={() => switchVersionContext(false)}>回到对外版本</Button> : null}{managementReady && can("supply.restrict") && !historical ? <Button variant="outline" onClick={() => goSection("review")}>{restricted ? "复核已有限制" : "新增运营限制"}</Button> : null}</div>
     {!publicDraftAccount && detail.supervision.facts.publicVisible === false ? <p className="text-xs text-muted-foreground" role="status">当前资料尚未发布。</p> : null}
     {!publicDraftAccount && detail.supervision.facts.publicVisible === true && !detail.supervision.facts.publicVersionId ? <p className="text-xs text-muted-foreground" role="status">对外资料暂未核对，以下为当前资料。</p> : null}
     {!publicDraftAccount && detail.supervision.facts.publicVersionId && version.id === detail.supervision.facts.publicVersionId ? <p className="text-xs text-muted-foreground" role="status">正在查看对外资料。</p> : null}
     <AccountCompleteView showManagement={managementReady} detail={detail} version={version} historicalRead={detail.supervision.facts.historicalRead}
       canReviewMedia={managementReady && !historical && can("supply.review.decide")} busy={busy || readFailed} reasonReady={reason.trim().length >= 2}
       onZoom={openZoom} onQuarantine={id => begin("media", id, "QUARANTINE")} onRestore={id => begin("media", id, "APPROVE")}
       onSelectVersion={id => { if (busy || intent?.unknown) return; if (reasonIsDirty(reason)) { setVersionChoice({ id }); return; } changeArchiveVersion(id); }}
       versionId={versionId}
       actions={managementReady && !historical && version.reviewState === "SUBMITTED" && can("supply.review.decide") ? <><Button variant="outline" disabled={busy || readFailed} onClick={() => begin("APPROVE")}>通过历史审核</Button><Button variant="outline" disabled={busy || readFailed} onClick={() => begin("REJECT")}>退回历史审核</Button></> : undefined}/>

   </div> : detail.supervision.facts.historicalRead ? <ImportedAccountView read={detail.supervision.facts.historicalRead}/> : <p className="wf-empty">本账号尚无资料版本，其他对象事实仍可核对。</p>}
 </div>}
 {section === "records" && <div className="grid gap-5 text-sm">
   <section><h2 className="mb-2 text-base font-semibold">运营限制记录</h2>{detail.supervision.restrictionHistory.state === "NOT_RECORDED" ? <p className="text-muted-foreground">限制历史未提供</p> : detail.supervision.restrictionHistory.items.length ? <ul className="divide-y">{detail.supervision.restrictionHistory.items.map(e => <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{e.restricted === true ? "施加限制" : e.restricted === false ? "解除限制" : "处置状态未记录"} · {e.reason ?? "原因未记录"}</span><span className="text-xs text-muted-foreground">{e.actorName ?? "处理人未记录"} · {fullShanghaiTime(e.occurredAt)}</span></li>)}</ul> : <p className="text-muted-foreground">最近 {detail.supervision.restrictionHistory.limit} 条已记录事件中没有限制事件。</p>}</section>
   <section><h2 className="mb-2 text-base font-semibold">资料版本</h2>{detail.supervision.changes ? <p>相对第{detail.supervision.changes.previousSequence}版{detail.supervision.changes.changed ? "有资料变化" : "无资料变化"}。<Button variant="link" type="button" className="ml-2 hover:underline" onClick={() => goSection("changes")}>查看差异 ›</Button></p> : <p className="text-muted-foreground">没有更早的资料版本记录。</p>}</section>
   {detail.supervision.facts.sources.length || detail.supervision.facts.legacyNumbers.length || detail.supervision.facts.historicalRead ? <Collapsible className="border-t pt-4"><CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">来源与迁入前记录<ArrowUpRight className="size-3.5" aria-hidden="true"/></CollapsibleTrigger><CollapsibleContent className="space-y-5 pt-4">
     <dl className="grid gap-2 break-all text-xs text-muted-foreground"><div><dt>迁入来源</dt><dd>{detail.supervision.facts.sources.length ? detail.supervision.facts.sources.map(s => s.sourceSystem + "/" + s.sourceEntity + " · " + s.sourceId + "（旧编号：" + (s.businessNo ?? "待核") + "）").join("；") : "未记录旧来源"}</dd></div><div><dt>旧业务编号</dt><dd>{detail.supervision.facts.legacyNumbers.length ? detail.supervision.facts.legacyNumbers.join("、") : "未记录旧业务编号"}</dd></div></dl>
     {detail.supervision.facts.historicalRead ? <ImportedAccountView read={detail.supervision.facts.historicalRead}/> : null}
   </CollapsibleContent></Collapsible> : null}
 </div>}
 {section === "changes" && <div className="grid items-start gap-5 text-sm xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]" data-account-media-review>
   <section className="min-w-0 space-y-3"><h2 className="text-base font-semibold">本版申报与对应图片</h2>{publicDefault ? <PublicBasisView basis={publicDefault}/> : version ? <><Table className="text-sm"><TableHeader><TableRow><TableHead>申报项</TableHead><TableHead>{previous ? "前版 " + previous.sequence : "前版未提供"}</TableHead><TableHead>当前第{version.sequence}版</TableHead></TableRow></TableHeader><TableBody>{inventoryRows(version, detail.previousDeclaration, detail.previousPresentation?.items).map(row => <TableRow key={row.itemId}><TableHead>{row.name} · {row.unit}</TableHead><TableCell>{row.previous}</TableCell><TableCell>{row.current}</TableCell></TableRow>)}</TableBody></Table>{image(currentMedia, "本版相关展示图")}<p className="text-xs leading-relaxed text-muted-foreground">前版差异来自记录的资料版本，不作自动风险判断；完整字段在档案中核对。</p></> : <p>当前没有资料版本，不能编造库存或图片。</p>}</section>
   <div className="min-w-0 space-y-5">
     <section className="space-y-3 rounded-xl border border-border p-4"><h2 className="text-base font-semibold">图片核对与处理</h2>{publicDefault ? <Alert role="status"><AlertTitle>对外版本只读</AlertTitle><AlertDescription><p>审核和图片处置属于当前草稿，请先切换后核对。</p><Button variant="outline" disabled={contextSwitchBlocked} onClick={() => switchVersionContext(true)}>查看当前草稿</Button></AlertDescription></Alert> : currentMedia && can("supply.review.decide") ? <>
       <label className="grid gap-2 text-sm font-medium">本次图片核对说明<Textarea aria-label="本次图片核对说明" rows={4} className="min-h-24 resize-y font-normal" value={reason} disabled={historical || readFailed || busy} onChange={e => setReason(e.target.value)} maxLength={500}/></label>
       <p className="text-xs leading-relaxed text-muted-foreground">写明本图与申报资料的核对依据。确认时绑定账号、资料版及图片修订；其他限制独立保留。</p>
       <div className="flex flex-wrap gap-2"><Button variant={currentMedia.reviewState === "QUARANTINED" ? "outline" : "destructive"} disabled={historical || readFailed || busy || reason.trim().length < 2 || !currentMedia.mediaRevision || !currentMedia.byteHash} onClick={() => begin("media", currentMedia.assetId, currentMedia.reviewState === "QUARANTINED" ? "APPROVE" : "QUARANTINE")}>{currentMedia.reviewState === "QUARANTINED" ? "核对后恢复本图" : "确认前核对并隔离本图"}</Button><Button variant="outline" onClick={() => void copy()}>复制修订核对摘要</Button></div>
     </> : <p>{currentMedia ? "当前没有图片处置权限，可核对并交受权人员处理。" : initialQuery.assetId ? "所选图片未绑定当前版本，只能核对历史/未绑定来源；合法后续处理合同尚待补齐。" : "没有可处置的当前展示图。"}来源缺失不认定图文正确。</p>}</section>
     {can("supply.duplicate.review") && !historical ? <Collapsible className="border-t pt-4"><CollapsibleTrigger className="flex w-full items-center justify-between rounded-sm text-left font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"><span>疑似重复线索{detail.duplicateHints.length ? " · " + detail.duplicateHints.length + " 条" : ""}</span><ArrowUpRight className="size-3.5" aria-hidden="true"/></CollapsibleTrigger><CollapsibleContent className="space-y-3 pt-3">
       <p className="text-xs leading-relaxed text-muted-foreground">仅记录人工判断，不自动合并账号或改变归属。</p>{detail.duplicateHints.map(hint => <p key={hint.id}>{hint.result === "DISTINCT" ? "已判断为不同账号" : hint.result === "POSSIBLE_SAME" ? "可能为同一账号" : "待核对"}：{hint.reason}</p>)}
       <label className="grid gap-2 text-sm font-medium">关联队列中的另一个账号<SupplySelect label="关联队列中的另一个账号" value={related} onValueChange={setRelated} disabled={busy || readFailed} options={[{ value: "", label: "请选择同游戏账号" }, ...relatedItems.filter(item => item.id !== detail.account.id && item.game_id === detail.account.game_id).map(item => ({ value: item.id, label: (item.title || "未命名资料") + " · " + item.owner_name }))]}/></label>
       {!currentMedia ? <p className="text-xs text-muted-foreground">记录线索需要至少一张账号图片作为证据。</p> : null}<Button variant="outline" size="sm" disabled={busy || readFailed || !related || !currentMedia} onClick={() => begin("duplicate")}>记录关联线索</Button>
     </CollapsibleContent></Collapsible> : null}
   </div>
 </div>}
 {section === "review" && restricted && <div className="grid gap-4 text-sm lg:grid-cols-3"><section className="rounded-xl p-4 ring-1 ring-foreground/10 grid content-start gap-2"><h2 className="text-base font-semibold">复核已有限制 · 原限制与证据</h2><p className="font-medium">{original?.reason ?? (restricted ? detail.account.restriction_reason : "未提供已施加的原限制记录") ?? "原因未记录"}</p><p className="text-xs text-muted-foreground">{original?.actorName ?? "处理人未记录"} · {original ? fullShanghaiTime(original.occurredAt) : "时间未记录"} · {original?.beforeRevision ? "原修订" + original.beforeRevision : "原修订未提供"}</p>{image(original?.versionId === version?.id ? currentMedia : previousMedia, "原版相关展示图")}<p className="text-xs text-muted-foreground">图片仅是对应版本资料，原审计未绑定具体图时不宣称它就是原限制依据。原记录保留。</p></section><section className="rounded-xl p-4 ring-1 ring-foreground/10 grid content-start gap-2"><h2 className="text-base font-semibold">本次资料：核对后再处置</h2><p>{version ? "当前第" + version.sequence + "版 · " + reviewStateLabel(version.reviewState) : "当前资料未提供"}</p>{image(currentMedia, "当前新版相关展示图")}<p className="text-xs text-muted-foreground">{summary!.reason}。查看图片不会自动完成复核。</p></section><section className="rounded-xl p-4 ring-1 ring-foreground/10 grid content-start gap-2"><h2 className="text-base font-semibold">核对结论与处置</h2>{can("supply.restrict") && version ? <div className="grid gap-3">{restricted && <div className="flex items-start gap-2"><Checkbox id="supply-restriction-check" className="mt-0.5" aria-label="已核对当前资料且原限制问题已解决" checked={checked} disabled={historical || readFailed || busy} onCheckedChange={setChecked}/><label htmlFor="supply-restriction-check">我已核对当前资料，确认原限制问题已解决</label></div>}<label className="grid gap-1.5 font-medium">{restricted ? "本次解除依据与说明" : "已核对的问题与限制原因"}<Textarea className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm font-normal outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30" aria-label={restricted ? "本次解除依据与说明" : "已核对的问题与限制原因"} value={reason} disabled={historical || readFailed || busy} onChange={e => setReason(e.target.value)} maxLength={500}/></label><Button variant="destructive" disabled={historical || readFailed || busy || reason.trim().length < 2 || restricted && !checked} onClick={() => begin("restriction")}>{restricted ? "核对完成，确认解除影响" : "核对后确认运营限制"}</Button><p className="text-xs text-muted-foreground">对象/版本/权限/原因在确认时再核。号主暂停、其他资格与既有订单独立保留。</p></div> : <p className="text-amber-700 dark:text-amber-400">当前只读监管依据，没有运营限制处置权限。</p>}<Collapsible className="border-t pt-2 text-xs text-muted-foreground"><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="justify-start px-0"/>}>原记录与交接</CollapsibleTrigger><CollapsibleContent keepMounted className="mt-2 space-y-2 data-[closed]:hidden">{detail.supervision.restrictionHistory.items.map(e => <p key={e.id}>{e.restricted === true ? "施加限制" : e.restricted === false ? "解除限制" : "处置状态未记录"} · {e.reason ?? "原因未记录"} · {e.actorName ?? "处理人未记录"} · {fullShanghaiTime(e.occurredAt)}</p>)}<p>显示最近{detail.supervision.restrictionHistory.limit}条相关成功事件；未记录不等于无历史问题。</p><Button variant="outline" onClick={() => void copy()}>复制给复核人员的摘要</Button></CollapsibleContent></Collapsible></section></div>}
 {section === "review" && !restricted && <div className="grid gap-4 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><section className="rounded-xl p-4 ring-1 ring-foreground/10 grid content-start gap-2"><h2 className="text-base font-semibold">新增运营限制</h2><p className="text-xs text-muted-foreground">当前没有运营限制。发现违规、资料不实或纠纷时可限制接新单；进行中的订单按原订单处理。</p><ReasonSummary facts={detail.supervision.facts} heading="当前接单情况"/></section><section className="rounded-xl p-4 ring-1 ring-foreground/10 grid content-start gap-2"><h2 className="text-base font-semibold">限制原因与确认</h2>{can("supply.restrict") && version ? <div className="grid gap-3">{restricted && <div className="flex items-start gap-2"><Checkbox id="supply-restriction-check" className="mt-0.5" aria-label="已核对当前资料且原限制问题已解决" checked={checked} disabled={historical || readFailed || busy} onCheckedChange={setChecked}/><label htmlFor="supply-restriction-check">我已核对当前资料，确认原限制问题已解决</label></div>}<label className="grid gap-1.5 font-medium">{restricted ? "本次解除依据与说明" : "已核对的问题与限制原因"}<Textarea className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm font-normal outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30" aria-label={restricted ? "本次解除依据与说明" : "已核对的问题与限制原因"} value={reason} disabled={historical || readFailed || busy} onChange={e => setReason(e.target.value)} maxLength={500}/></label><Button variant="destructive" disabled={historical || readFailed || busy || reason.trim().length < 2 || restricted && !checked} onClick={() => begin("restriction")}>{restricted ? "核对完成，确认解除影响" : "核对后确认运营限制"}</Button><p className="text-xs text-muted-foreground">对象/版本/权限/原因在确认时再核。号主暂停、其他资格与既有订单独立保留。</p></div> : <p className="text-amber-700 dark:text-amber-400">当前只读监管依据，没有运营限制处置权限。</p>}<Collapsible className="border-t pt-2 text-xs text-muted-foreground"><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="justify-start px-0"/>}>原记录与交接</CollapsibleTrigger><CollapsibleContent keepMounted className="mt-2 space-y-2 data-[closed]:hidden">{detail.supervision.restrictionHistory.items.map(e => <p key={e.id}>{e.restricted === true ? "施加限制" : e.restricted === false ? "解除限制" : "处置状态未记录"} · {e.reason ?? "原因未记录"} · {e.actorName ?? "处理人未记录"} · {fullShanghaiTime(e.occurredAt)}</p>)}<p>显示最近{detail.supervision.restrictionHistory.limit}条相关成功事件；未记录不等于无历史问题。</p><Button variant="outline" onClick={() => void copy()}>复制给复核人员的摘要</Button></CollapsibleContent></Collapsible></section></div>}
 {section === "orders" && <div className="wf-order-context wf-work-face"><section><h2>当前账号与号主</h2><dl className="wf-definitions"><div><dt>当前号主</dt><dd>{detail.ownerName} · {detail.account.owner_user_id}</dd></div><div><dt>当前资料</dt><dd>{version ? "第" + version.sequence + "版" : "未提供"}</dd></div></dl><p className="wf-hint">本单原主体与冻结资料按订单接口保留，不用当前号主或资料覆盖。</p>{detail.supervision.ownerLink.state === "READY" && <Button variant="link" type="button" className="wf-link" onClick={userTarget}>查看当前号主<ArrowUpRight size={13}/></Button>}</section><section><h2>关联订单与履约入口</h2>{detail.supervision.orders.state === "DENIED" ? <p className="wf-warning">没有订单读取权限，原双方和订单数量不显示为0。</p> : <>{detail.supervision.orders.items?.map(order => <div className="wf-linked-order" key={order.id}><strong className="wf-order-no">{order.displayNo}</strong><p>{order.source.statusLabel ?? order.status} · {orderPaymentText(order.payment.state)}</p><p>本单原号主：{order.ownerName ?? "未提供"} · 租客：{order.renterName ?? "未提供"}</p><p>订单资料：{order.versionId ? "已冻结原版本" : "旧版本引用未完整，不能编造"}；{order.ownerUserId !== detail.account.owner_user_id ? "当前号主与本单原号主不同。" : "当前号主与本单原号主相同。"}</p><div className="wf-task-actions"><Button onClick={() => orderTarget(order.id, order.displayNo)}>进入本单完整详情</Button><Button variant="outline" onClick={() => void copy(order)}>复制本单核对摘要</Button></div></div>)}{!detail.supervision.orders.items?.length && <p>当前授权范围没有匹配订单；不能推定全平台没有历史订单。</p>}<p className="wf-hint">当前范围{detail.supervision.orders.total}条，显示最近5条；订单读取不等群、利润或资金权限。</p></>}</section></div>}
 {managementReady ? <footer className="wf-handoff"><Collapsible className="min-w-0 flex-1 text-xs text-muted-foreground"><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="justify-start px-0 whitespace-normal"/>}>最近选择的核对摘要与手动交接</CollapsibleTrigger><CollapsibleContent keepMounted className="data-[closed]:hidden"><pre>{manualSummary ?? handoff}</pre><Button variant="outline" onClick={() => void copy()}><Copy size={15}/>复制业务核对摘要</Button></CollapsibleContent></Collapsible><Button variant="ghost" onClick={back} disabled={busy || intent?.unknown}>回原工作视图继续查看</Button>{copyNotice && <p role="status">{copyNotice}</p>}</footer> : null}</>}
 {intent && <SupplyActionDialog title={intent.title} objectLabel={intent.objectLabel} imageSrc={intent.assetId ? mediaContentUrl(intent.assetId) : undefined} stale={stale && !intent.unknown} unknown={Boolean(intent.unknown)} onRecheck={() => { if (busy || intent.unknown)
        return; setIntent(undefined); setChecked(false); setFeedback(undefined); void reread(); }} consequence={intent.consequence} conditions={intent.conditions} reason={String(intent.request?.body.reason ?? reason)} onReasonChange={value => { if (!intent.request)
        setReason(value); }} onConfirm={() => void confirm()} onClose={() => { if (!busy && !intent.unknown) {
        setIntent(undefined);
        setFeedback(undefined);
    } }} busy={busy} conflict={Boolean(intent.invalid)} feedback={feedback} onRefresh={() => void reread()}/>}
 {versionChoice && <Dialog open onOpenChange={open => { if (!open) setVersionChoice(undefined); }}><DialogContent closeLabel="关闭窗口"><DialogTitle>切换资料版本？</DialogTitle><DialogDescription>当前未提交的核对说明将丢弃。取消可保留说明。</DialogDescription><DialogFooter><Button variant="outline" size="lg" onClick={() => setVersionChoice(undefined)}>保留说明</Button><Button variant="destructive" size="lg" onClick={() => changeArchiveVersion(versionChoice.id)}>放弃说明并切换</Button></DialogFooter></DialogContent></Dialog>}
 {zoom && <Dialog open onOpenChange={open => { if (!open) closeZoom(); }}><DialogContent data-account-image="" showCloseButton={false} initialFocus={zoomClose} finalFocus={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(960px,calc(100vw-4rem))]"><div className="flex items-start justify-between gap-4"><DialogTitle className="min-w-0 break-words text-base">{zoom.caption ?? zoom.alt}</DialogTitle><Button ref={zoomClose} variant="outline" size="sm" className="shrink-0" onClick={closeZoom}>关闭 Esc</Button></div><img src={zoom.src} alt={zoom.alt} className="max-h-[calc(100dvh-10rem)] w-full rounded-lg bg-muted object-contain"/><DialogDescription>只读取已授权的同一张图片；放大查看不会提交审核或改变公开状态。</DialogDescription></DialogContent></Dialog>}
 </section>;
}
