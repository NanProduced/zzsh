import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Copy, Download, Search } from "lucide-react";
import { AdminApiError, friendlyError, ADMIN_AUTH_FAILURE_EVENT, type SessionSnapshot } from "../api";
import type { WorkspaceTab } from "../workspace/tab-model";
import { FINANCE_ACCESS_FAILURE_EVENT, bucketLabels, kindLabels, stateLabels, reasonLabels, defaultFinanceFilters, financeQuery, financeRead, downloadFinanceCsv, financeMoney, financeTime, type FinanceFilters, type FinanceResponse, type FinanceDocument, type FinanceEntry } from "./admin-finance-api";
import "./admin-finance.css";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type SavedView = { applied: FinanceFilters; draft: FinanceFilters; page: number; scroll: number; focus?: string; snapshot?: string };
type Origin = { path: string; parent?: string };
const savedViews = new Map<string, SavedView>(), origins = new Map<string, Origin>();
let currentIdentity = "";
export function clearFinanceContexts(): void { savedViews.clear(); origins.clear(); currentIdentity = ""; }
function scroller() { const page = document.querySelector<HTMLElement>(".workspace-page"); return page && page.scrollHeight > page.clientHeight ? page : document.scrollingElement; }
function has(snapshot: Snapshot, permission: string) { return snapshot.permissions.includes(permission); }
function filtersFromTab(tab: WorkspaceTab, period: boolean): FinanceFilters {
  const result = defaultFinanceFilters(period);
  for (const key of ["scope", "from", "to", "bucket", "kind", "state", "q"] as const) if (tab.query[key]) result[key] = tab.query[key]!;
  if (tab.query.period) result.period = tab.query.period === "1";
  return result;
}
function navigationKey(tab: WorkspaceTab, query = tab.query): string { return JSON.stringify([tab.id, tab.path, ...["scope", "from", "to", "period", "bucket", "kind", "state", "q", "page", "entry", "origin", "reset"].map(key => query[key] ?? "")]); }
function label(code: string) { return reasonLabels[code] ?? "该项依据尚未取得"; }
function emptyText(value: string | null | undefined) { return value ?? "未取得"; }
function entryClass(entry: FinanceEntry) { return entry.classification === "HISTORICAL_COVERED" ? "已含迁移期初" : entry.classification === "HISTORICAL_UNCOVERED" ? "历史待核，未入当前余额" : entry.classification === "OPENING" ? "迁移期初入账" : "当前分录"; }
const evidenceLabels: Record<string, string> = { intentId: "原申请", grossCents: "申请金额", netCents: "净额", feeCents: "手续费", policyVersion: "政策版本", fundsDisposition: "资金处置", acceptedAt: "申请时间", channelState: "渠道结果", channelReference: "渠道引用", queryRef: "最近查询引用", queriedAt: "最近查询", paymentConfirmationId: "原支付确认", settlementVersionId: "结算版本", refundPayableCents: "退款应付", refundDueAt: "退款责任到期", postedPlatformContributionCents: "原账平台分项", openingCutoff: "迁移截止", coveredCount: "覆盖笔数", originalReference: "原关联引用", originalNumber: "原编号", originalStatus: "原状态", originalNetCents: "原净额", originalFeeCents: "原手续费", dueAt: "结算日期" };
Object.assign(evidenceLabels, { originalOperationRef: "原本地渠道记录", originalOperationRecordedAt: "记录时间", originalOperationOutcome: "原本地渠道结果", originalOperationReference: "原本地渠道引用" });
Object.assign(evidenceLabels, { originalOrderNumber: "原订单号", originalOrderId: "原订单来源ID", ownerSubjectId: "号主用户ID", renterSubjectId: "租客用户ID", historicalBalanceAfterCents: "历史记录后余额", originalOrderStatus: "原订单状态", originalPaymentStatus: "原付款状态", recordedDueCents: "订单记录应付", recordedPaidCents: "旧记录付款", recordedDepositCents: "记录押金", postingCapturedCents: "原入账基数" });
Object.assign(evidenceLabels, { refundPaidCents: "已退金额", refundPaymentReference: "退款出款引用" });
function evidenceValue(key: string, value: string | null) { return key.endsWith("Cents") ? financeMoney(value) : /At$|Cutoff$/.test(key) ? financeTime(value) : emptyText(value); }
function decodeReference(value: string) { try { return decodeURIComponent(value); } catch { return "INVALID_REFERENCE"; } }

export function AdminFinanceView({ tab, snapshot, onOpenPath, onQueryChange, onRefresh, refreshNonce }: {
  tab: WorkspaceTab; snapshot: Snapshot; onOpenPath: (path: string, title?: string) => void; onQueryChange: (query: Record<string, string>) => void; onRefresh: () => Promise<SessionSnapshot>; refreshNonce: number;
}) {
  const identity = `${snapshot.adminUserId}:${snapshot.session.id}:${[...snapshot.permissions].sort().join("|")}`;
  if (identity !== currentIdentity) { clearFinanceContexts(); currentIdentity = identity; }
  const period = tab.path === "/finance/period", documentId = tab.path.startsWith("/finance/documents/") ? decodeReference(tab.path.slice(19)) : null;
  const subjectId = tab.path.startsWith("/finance/users/") ? decodeReference(tab.path.slice(15)) : null, object = documentId !== null || subjectId !== null;
  const viewKey = `${identity}:${tab.id}`, saved = savedViews.get(viewKey);
  const incomingNavigation = navigationKey(tab), previousNavigation = useRef(incomingNavigation), ownNavigation = useRef<string | undefined>(undefined);
  const externalNavigationChanged = previousNavigation.current !== incomingNavigation && ownNavigation.current !== incomingNavigation;
  const [applied, setApplied] = useState<FinanceFilters>(() => saved?.applied ?? filtersFromTab(tab, period));
  const [draft, setDraft] = useState<FinanceFilters>(() => saved?.draft ?? filtersFromTab(tab, period));
  const [page, setPage] = useState(saved?.page ?? (Number(tab.query.page) > 0 ? Number(tab.query.page) : 1));
  const [read, setRead] = useState<{ identity: string; requestKey: string; body: FinanceResponse }>();
  const [error, setError] = useState<unknown>(), [nonce, setNonce] = useState(0), [advanced, setAdvanced] = useState(false);
  const [summary, setSummary] = useState<string>(), [notice, setNotice] = useState<string>(), [exporting, setExporting] = useState(false);
  const requestSequence = useRef(0), exportController = useRef<AbortController | null>(null), snapshotRef = useRef(saved?.snapshot), previousRefresh = useRef(refreshNonce);
  const remembered = useRef<SavedView>(saved ?? { applied, draft, page, scroll: 0 });
  const requestKey = JSON.stringify([tab.path, applied, page, tab.query.entry ?? ""]);
  const body = !externalNavigationChanged && read?.identity === identity && read.requestKey === requestKey ? read.body : undefined;
  const documentAllowed = has(snapshot, "finance.document.read");
  const allowed = documentId !== null ? documentAllowed : period || subjectId ? has(snapshot, "finance.read") : has(snapshot, "finance.read") || documentAllowed;
  const needsLookup = !object && !period && !has(snapshot, "finance.read") && !applied.q.trim();
  remembered.current = { ...remembered.current, applied, draft, page, snapshot: snapshotRef.current };
  function accessFailure(cause: unknown) {
    setRead(undefined); setSummary(undefined); snapshotRef.current = undefined; exportController.current?.abort();
    if (cause instanceof AdminApiError && [401, 403, 423].includes(cause.status)) {
      clearFinanceContexts(); window.dispatchEvent(new CustomEvent(FINANCE_ACCESS_FAILURE_EVENT)); void onRefresh().catch(() => undefined);
    }
  }
  useLayoutEffect(() => {
    if (previousNavigation.current === incomingNavigation) return;
    previousNavigation.current = incomingNavigation;
    if (ownNavigation.current === incomingNavigation) { ownNavigation.current = undefined; return; }
    ownNavigation.current = undefined; requestSequence.current++; snapshotRef.current = undefined;
    exportController.current?.abort(); exportController.current = null; setExporting(false);
    const filters = filtersFromTab(tab, period), nextPage = /^[1-9]\d{0,5}$/.test(tab.query.page ?? "") ? Number(tab.query.page) : 1;
    remembered.current = { applied: filters, draft: filters, page: nextPage, scroll: 0 };
    setRead(undefined); setError(undefined); setSummary(undefined); setNotice(undefined);
    setApplied(filters); setDraft(filters); setPage(nextPage);
  }, [incomingNavigation, period]);
  useEffect(() => {
    const clear = () => { clearFinanceContexts(); requestSequence.current++; setRead(undefined); setSummary(undefined); setError(undefined); snapshotRef.current = undefined; exportController.current?.abort(); };
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, clear);
    return () => { window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, clear); exportController.current?.abort(); };
  }, []);
  useLayoutEffect(() => {
    const rememberScroll = () => { remembered.current.scroll = scroller()?.scrollTop ?? 0; };
    window.addEventListener("scroll", rememberScroll, true);
    return () => { window.removeEventListener("scroll", rememberScroll, true); if (currentIdentity === identity) savedViews.set(viewKey, { ...remembered.current }); };
  }, [identity, viewKey]);
  useEffect(() => {
    const controller = new AbortController(), sequence = ++requestSequence.current;
    if (previousRefresh.current !== refreshNonce) { snapshotRef.current = undefined; previousRefresh.current = refreshNonce; }
    setRead(undefined); setError(undefined); setSummary(undefined); setNotice(undefined); exportController.current?.abort();
    if (!allowed || needsLookup || externalNavigationChanged) return () => controller.abort();
    const route = documentId ? `documents/${encodeURIComponent(documentId)}` : subjectId ? `subjects/${encodeURIComponent(subjectId)}` : period ? "period" : "lookup";
    async function load() {
      const extras: Record<string, string> = { page: String(page), pageSize: "20", ...(tab.query.entry ? { entry: tab.query.entry } : {}) };
      if (!snapshotRef.current && page > 1 && !object) { const first = await financeRead(route, applied, controller.signal, { page: "1" }); if(controller.signal.aborted || sequence !== requestSequence.current || identity !== currentIdentity)return; snapshotRef.current = first.snapshot; }
      if (snapshotRef.current) extras.snapshot = snapshotRef.current;
      const value = await financeRead(route, applied, controller.signal, extras);
      if (controller.signal.aborted || sequence !== requestSequence.current || identity !== currentIdentity) return;
      snapshotRef.current = value.snapshot; remembered.current.snapshot = value.snapshot; setRead({ identity, requestKey, body: value });
    }
    void load().catch(cause => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      accessFailure(cause); setError(cause);
    });
    return () => controller.abort();
  }, [identity, applied, page, period, documentId, subjectId, tab.query.entry, refreshNonce, nonce, allowed, needsLookup, externalNavigationChanged]);
  useLayoutEffect(() => {
    if (!body) return;
    const container = scroller(); if (container) container.scrollTop = remembered.current.scroll;
    const focus = remembered.current.focus;
    if (focus) document.querySelector<HTMLElement>(`[data-finance-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }, [body]);
  const changed = JSON.stringify(applied) !== JSON.stringify(draft);
  const queryPath = (filters: FinanceFilters, targetPage = page) => `${tab.path}?${financeQuery(filters)}&page=${targetPage}${tab.query.origin ? `&origin=${encodeURIComponent(tab.query.origin)}` : ""}${tab.query.entry ? `&entry=${encodeURIComponent(tab.query.entry)}` : ""}`;
  function apply() {
    snapshotRef.current = undefined; remembered.current.scroll = 0; remembered.current.focus = "finance-lookup";
    setRead(undefined); setApplied({ ...draft }); setPage(1); setNonce(value => value + 1);
    const nextQuery = { ...Object.fromEntries(financeQuery(draft)), page: "1" }; ownNavigation.current = navigationKey(tab, nextQuery); onQueryChange(nextQuery);
  }
  function retry() { snapshotRef.current = undefined; setError(undefined); setNonce(value => value + 1); remembered.current.focus = object ? "finance-title" : "finance-lookup"; }
  function open(path: string, title: string, focus: string) {
    remembered.current.focus = focus; remembered.current.scroll = scroller()?.scrollTop ?? 0; remembered.current.snapshot = snapshotRef.current;
    savedViews.set(viewKey, { ...remembered.current });
    const origin = crypto.randomUUID(); origins.set(origin, { path: queryPath(applied), parent: tab.query.origin });
    onOpenPath(path + (path.includes("?") ? "&" : "?") + new URLSearchParams({ ...Object.fromEntries(financeQuery(applied)), origin }), title);
  }
  function back() {
    const origin = tab.query.origin ? origins.get(tab.query.origin) : null;
    onOpenPath(origin?.path ?? "/finance", origin ? undefined : "资金查找");
  }
  async function exportCsv() {
    if (!body || exporting) return;
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setNotice(undefined);
    try {
      const receipt = await downloadFinanceCsv(body.applied, body.snapshot, controller.signal);
      if (controller.signal.aborted || identity !== currentIdentity) return;
      const href = URL.createObjectURL(receipt.blob), anchor = document.createElement("a"); anchor.href = href; anchor.download = receipt.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      setNotice(`已接收 ${receipt.rowCount ?? "全部"} 条并交浏览器下载。请求编号：${receipt.requestId ?? "未取得"}`);
    } catch (cause) { if (!controller.signal.aborted) { accessFailure(cause); setError(cause); } }
    finally { if (exportController.current === controller) { exportController.current = null; setExporting(false); } }
  }
  function documentPath(document: FinanceDocument, entry?: string) { return `/finance/documents/${encodeURIComponent(document.ref)}${entry ? `?entry=${encodeURIComponent(entry)}` : ""}`; }
  function changePage(next: number) { setRead(undefined); remembered.current.scroll = 0; remembered.current.focus = undefined; setPage(next); const query = { ...Object.fromEntries(financeQuery(applied)), page: String(next) }; ownNavigation.current = navigationKey(tab, query); onQueryChange(query); }
  async function copySummary() {
    if (!body?.document) return;
    const text = [body.document.number, `${kindLabels[body.document.kind] ?? "资金记录"} · ${stateLabels[body.document.state] ?? "状态待核"}`, `截至：${financeTime(body.asOf)}`,
      ...(body.entries ?? []).map(entry => `${entry.subjectName} / ${bucketLabels[entry.bucket]}：${financeMoney(entry.deltaCents)}，${entryClass(entry)}，${entry.id}`),
      ...Object.entries(body.evidence ?? {}).filter(([key, value]) => evidenceLabels[key] && value !== null).map(([key, value]) => `${evidenceLabels[key]}：${evidenceValue(key, value)}`),
      ...(body.reasonCodes ?? []).map(label), `快照：${body.snapshotVersion}`, ...(body.entries ?? []).map(entry => `来源：${entry.sourceType}/${entry.sourceSystem}/${entry.sourceEntity}/${entry.sourceId}${entry.sourceDigest ? ` / ${entry.sourceDigest}` : ""}`)].join("\n");
    setSummary(text); try { await navigator.clipboard.writeText(text); setNotice("摘要已复制"); } catch { setNotice("复制未完成，可从下方摘要选择复制"); }
  }
  const resultLimit = error instanceof AdminApiError && error.details.some(detail=>detail.path.startsWith("finance.matchingLimit")||detail.path.startsWith("finance.exportLimit"));
  const title = body?.document?.number ?? body?.subject?.name ?? (object ? "资金详情" : period ? "期间核对" : "资金查找");
  const pagination = body && !object ? <div className="finance-pagination"><span>{page} 页 · {body.subjectCount ?? 0} 个用户 / {body.documentCount ?? 0} 张单据 / {body.entryCount ?? 0} 条分录</span><div><button disabled={page === 1} onClick={() => changePage(page - 1)}>上一页</button><button disabled={!body.hasMore} onClick={() => changePage(page + 1)}>下一页</button></div></div> : null;
  const candidates = (documents: FinanceDocument[]) => <div className="finance-candidates">{documents.map(document => <article key={document.ref}><div className="finance-candidate-main"><small>{kindLabels[document.kind] ?? "资金记录"} · {document.subjects.map(subject => subject.name).join(" / ")}</small><button className="finance-object-link" disabled={!documentAllowed} title={!documentAllowed?"需要单据资金读取能力":undefined} data-finance-focus={document.ref} onClick={() => open(documentPath(document), document.number, document.ref)}>{document.number}<ArrowUpRight size={15} /></button><p>{document.entryCount} 条分录</p></div><div className="finance-candidate-facts"><span>{stateLabels[document.state] ?? "状态待核"}</span>{document.requestedAmountCents !== null ? <strong>{financeMoney(document.requestedAmountCents)}</strong> : null}<small>{financeTime(document.occurredAt)}</small></div></article>)}</div>;
  const entries = (lines: FinanceEntry[]) => <div className="finance-table"><table className="entries-table"><thead><tr><th>单据 / 主体</th><th>资金类别</th><th>状态 / 分类</th><th className="numeric">变动金额</th><th>核对</th></tr></thead><tbody>{lines.map(entry => <tr key={entry.id}><td><strong>{entry.documentNumber}</strong><span>{entry.subjectName}</span><small>{financeTime(entry.occurredAt)}</small></td><td>{bucketLabels[entry.bucket] ?? "类别待核"}<small>{entry.direction === "IN" ? "增加" : entry.direction === "OUT" ? "减少" : "方向待核"}</small></td><td>{stateLabels[entry.state] ?? "状态待核"}<small>{entryClass(entry)}</small></td><td className="numeric"><strong className="amount">{financeMoney(entry.deltaCents)}</strong></td><td><button disabled={!documentAllowed} title={!documentAllowed?"需要单据资金读取能力":undefined} data-finance-focus={entry.id} onClick={() => open(`/finance/documents/${encodeURIComponent(entry.documentRef)}?entry=${encodeURIComponent(entry.id)}`, entry.documentNumber, entry.id)}>查看<ArrowUpRight size={14} /></button></td></tr>)}</tbody></table></div>;

  return <section className="finance-page" aria-labelledby="finance-title">
    <div className="finance-page-header"><h1 id="finance-title" tabIndex={-1} data-finance-focus="finance-title">{allowed ? title : "资金读取"}</h1><div className="finance-page-actions">{object ? <><button onClick={back}>返回来源</button><button onClick={() => { snapshotRef.current = undefined; onOpenPath("/finance?reset=1", "资金查找"); }}>重新查找</button>{body?.document ? <button className="primary" onClick={() => void copySummary()}><Copy size={15} />复制摘要</button> : null}</> : null}{period ? <button className="primary" disabled={!body || exporting || !!error} onClick={() => void exportCsv()}><Download size={15} />{exporting ? "正在生成" : "导出完整明细"}</button> : null}</div></div>
    {!allowed ? <div className="finance-empty" role="alert"><h2>当前身份没有该项资金读取能力</h2><p>{period || subjectId ? "完整钱包和期间核对需要完整资金读取能力。" : "单据读取需要对应能力。"}</p></div> : <>
      {!object ? <form className={period ? "finance-period-filter" : "finance-lookup"} onSubmit={event => { event.preventDefault(); apply(); }}>
        {period ? <><label>主体<input aria-label="主体" value={draft.scope} onChange={event => setDraft({ ...draft, scope: event.target.value })} placeholder="ALL 或用户ID" /></label><label>起日<input aria-label="起日" type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label><label>止日<input aria-label="止日" type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label></> : <><label htmlFor="finance-lookup">用户或业务单据</label><div className="finance-search-line"><div><Search size={17} /><input id="finance-lookup" data-finance-focus="finance-lookup" value={draft.q} onChange={event => setDraft({ ...draft, q: event.target.value })} placeholder="用户ID、昵称、单据号或本站链接" /></div><button className="primary" type="submit">查找</button><button type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>更多条件<ChevronDown size={14} /></button></div></>}
        {advanced ? <div className="finance-advanced"><label>业务<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value })}><option value="ALL">全部业务</option>{Object.entries(kindLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label>状态<select value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value })}><option value="ALL">全部状态</option>{Object.entries(stateLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><label>资金类别<select value={draft.bucket} onChange={event => setDraft({ ...draft, bucket: event.target.value })}><option value="ALL">全部类别</option>{Object.entries(bucketLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>{!period ? <label><input type="checkbox" checked={draft.period} onChange={event => setDraft({ ...draft, period: event.target.checked })} />限定期间</label> : null}{!period && draft.period ? <><label>起日<input type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label><label>止日<input type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label></> : null}</div> : null}
        {period ? <><button type="submit" className="primary" data-finance-focus="finance-lookup">应用</button><button type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>更多条件<ChevronDown size={14}/></button></> : null}{changed ? <p className="finance-draft-note" role="status">新条件尚未应用，结果和导出仍使用已应用范围。</p> : null}
      </form> : null}
      {error ? <div className="finance-empty" role="alert"><h2>{resultLimit ? "当前匹配结果过多" : error instanceof AdminApiError && error.status === 409 ? "本批数据已变化" : "资金读取暂不可用"}</h2><p>{resultLimit ? "请缩小主体、期间或业务条件后应用。当前结果超过有界读取或文件上限，未返回截断文件。" : error instanceof AdminApiError && error.status === 409 ? "请重新查询，避免拼接两个时点。" : friendlyError(error)}</p><button onClick={retry}>重新查询</button></div> : needsLookup ? <div className="finance-empty"><h2>输入单据编号或用户线索</h2><p>查找后选择要核对的单据。</p></div> : !body ? <div className="finance-loading" role="status"><p>正在读取资金依据…</p></div> : <>
        <div className="finance-applied"><strong>{object ? "当前对象" : period ? body.applied.scope === "ALL" ? "全平台" : `主体 ${body.applied.scope}` : "已应用线索"}</strong><span>{!object && body.applied.period ? `${body.applied.from} 至 ${body.applied.to} · 北京时间` : !object ? body.applied.q.replace(/^ORDER_LINK:/,"订单链接 · ") || "最近业务" : `${body.document?.entryCount ?? body.documents?.length ?? 0} ${body.document ? "条关联分录" : "张关联单据"}`}</span><small>数据截止 {financeTime(body.asOf)}</small></div>
        {!object && !period ? <>{body.subjects?.length ? <section><h2>用户候选</h2><div className="finance-user-candidates">{body.subjects.map(subject => <button key={subject.id} data-finance-focus={subject.id} onClick={() => open(`/finance/users/${encodeURIComponent(subject.id)}`, subject.name, subject.id)}>{subject.name}<small>{subject.id}</small><ArrowUpRight size={14} /></button>)}</div></section> : null}<h2>业务单据</h2>{body.documents?.length ? candidates(body.documents) : <div className="finance-empty"><h2>没有匹配单据</h2><p>可核对编号或调整查询条件。</p></div>}{pagination}</> : null}
        {period ? <><section className="finance-reconciliation"><h2>账内勾稽</h2><div className="finance-table"><table className="reconciliation-table"><thead><tr><th>资金类别</th><th>期间起始</th><th>已知增加</th><th>已知减少</th><th>期末</th><th>差额</th></tr></thead><tbody>{body.reconciliation?.map(row => <tr key={row.bucket}><td><strong>{bucketLabels[row.bucket]}</strong><span className="finance-mobile-verdict">差额 {financeMoney(row.difference)}</span></td><td data-label="期间起始">{financeMoney(row.openingBalance)}</td><td data-label="已知增加">{financeMoney(row.knownInflows)}<small>迁移入账 {financeMoney(row.migrationMovement)}</small></td><td data-label="已知减少">{financeMoney(row.knownOutflows)}<small>{row.unknownCount} 条金额待核</small></td><td data-label="期末">{financeMoney(row.closingBalance)}</td><td>{financeMoney(row.difference)}</td></tr>)}</tbody></table></div><details className="finance-period-basis"><summary>勾稽依据与缺项</summary><ul>{body.gaps?.map(reason => <li key={reason}>{label(reason)}</li>)}</ul>{body.reconciliation?.map(row => <p key={row.bucket}>{bucketLabels[row.bucket]}：历史已覆盖 {row.coveredHistoricalCount} 条，未覆盖 {row.uncoveredHistoricalCount} 条，事实时间未定 {row.unknownTimeCount} 条。</p>)}</details></section><h2>资金明细</h2>{body.entries?.length ? entries(body.entries) : <div className="finance-empty">该生效范围没有资金分录。</div>}{pagination}</> : null}
        {body.subject && body.wallet ? <><div className="finance-wallet"><h2>用户资金</h2><p>用户ID：{body.subject.id}</p><dl>{Object.entries(body.wallet.buckets).map(([key, value]) => <div key={key}><dt>{({ available: "可用", reserved: "提现预留", restricted: "受限", pendingEarnings: "待结算收益", refundPayable: "退款应付" } as Record<string, string>)[key] ?? "资金类别"}</dt><dd>{financeMoney(value.amountCents)}</dd></div>)}</dl><p>覆盖：{body.wallet.coverage.knowledge === "KNOWN" ? `已准入 · 迁移截止 ${financeTime(body.wallet.coverage.cutoff)}` : "未核定"}</p></div><button className="primary" onClick={() => { const next = { ...defaultFinanceFilters(true), scope: body.subject!.id }; onOpenPath(`/finance/period?${financeQuery(next)}`, "期间核对"); }}>核对该用户期间</button><details className="finance-help"><summary>可提现与来源缺项</summary><p>可提现 {financeMoney(body.wallet.withdrawable.amountCents)}</p>{[...(body.wallet.withdrawable.reasonCodes ?? []), ...(body.gaps ?? [])].map(reason => <p key={reason}>{label(reason)}</p>)}</details><h2>关联业务</h2>{candidates(body.documents ?? [])}</> : null}
        {body.document ? <><div className="finance-object-context"><strong>{kindLabels[body.document.kind]}</strong><span>{stateLabels[body.document.state] ?? "状态待核"}</span><span>{body.document.subjects.map(subject => subject.name).join(" / ")}</span></div><div className="finance-detail-layout"><div>{body.document.requestedAmountCents !== null ? <h2 className="finance-document-result">申请 {financeMoney(body.document.requestedAmountCents)}</h2> : null}<dl className="finance-fact-list">{Object.entries(body.evidence ?? {}).filter(([key]) => evidenceLabels[key]).map(([key, value]) => <div key={key}><dt>{evidenceLabels[key]}</dt><dd>{evidenceValue(key, value)}</dd></div>)}</dl>{body.reasonCodes?.map(reason => <p key={reason}>{label(reason)}</p>)}<details className="finance-help"><summary>资金来源与版本</summary>{body.entries?.map(entry => <p key={entry.id}>{entry.id} · {entry.sourceType}/${entry.sourceSystem}/{entry.sourceEntity}/{entry.sourceId}<br />{entryClass(entry)} · 采集 {financeTime(entry.importedAt)}<br />{entry.sourceDigest}</p>)}</details></div><aside className="finance-related"><h2>关联</h2>{body.document.subjects.filter(subject => subject.id !== "PLATFORM" && subject.id !== "SYSTEM" && has(snapshot, "finance.read")).map(subject => <button key={subject.id} data-finance-focus={`user:${subject.id}`} onClick={() => open(`/finance/users/${encodeURIComponent(subject.id)}`, subject.name, `user:${subject.id}`)}>{subject.name}<small>{subject.id}</small><ArrowUpRight size={14} /></button>)}{body.related?.filter(link => !link.path || (link.path.startsWith("/orders/") ? has(snapshot, "order.read") : has(snapshot, "supply.rental_account.read"))).map(link => <button key={link.ref+(link.path??"")} data-finance-focus={link.ref} onClick={() => link.path ? onOpenPath(link.path) : open("/finance/documents/"+encodeURIComponent(link.ref),link.label,link.ref)}>{link.label}<ArrowUpRight size={14} /></button>)}</aside></div><h2>相关分录</h2>{entries(body.entries ?? [])}</> : null}
        {summary && body.document ? <textarea className="finance-copy-box" aria-label="核对摘要" readOnly value={summary} rows={10} /> : null}
      </>}
      {notice ? <p role="status" className="finance-notice">{notice}</p> : null}
    </>}
  </section>;
}
