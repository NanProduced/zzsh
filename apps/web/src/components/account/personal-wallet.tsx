"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, CreditCard, FileText, Info, RefreshCw } from "lucide-react";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { formatOrderTime } from "@/lib/order-client";
import { walletWithdrawalNote, financeEntryLabel, walletSourceStatus,refundAttemptStatus,walletOriginalType, readMyWallet, readMyWalletEntries, readMyWalletEntry, walletMoney, WalletRequestError, type EntryBucket, type WalletRead, type WalletEntry, type WalletEntryPage, type WalletEntryDetail } from "@/lib/personal-wallet-client";
import { Amount, LocalRetry, RecordStatus, SkeletonBlock, StatusBadge } from "@/components/ui/information";
import "./personal-wallet.css";
import {ControlledWithdrawal} from './controlled-withdrawal';
import {BankBindingWorkspace} from './bank-binding-workspace';
import {OwnerGuaranteeHistory} from './owner-guarantee-history';

function useWalletRead(scope: string) {
  const session = useUserSession(), store = useUserSessionStore(), scopeRef = useRef(scope); scopeRef.current = scope;
  const [reload, setReload] = useState(0), [state, setState] = useState<{ scope: string; wallet: WalletRead | null; error: WalletRequestError | null; loading: boolean }>({ scope, wallet: null, error: null, loading: true });
  const ticket = useRef(0);
  const current = () => { const latest = store.getSnapshot(); return latest.status === "authenticated" && latest.userId === session.userId && `${latest.userId}:${latest.identityVersion}` === scopeRef.current; };
  const fail = (error: unknown) => { const e = error instanceof WalletRequestError ? error : new WalletRequestError(0, "NETWORK_ERROR"); setState({ scope, wallet: null, error: e, loading: false }); if (e.status === 401) session.revalidate(); };
  useEffect(() => {
    const id = ++ticket.current, abort = new AbortController(); setState({ scope, wallet: null, error: null, loading: true });
    if (!session.userId || !current()) return () => abort.abort();
    readMyWallet(session.userId, abort.signal).then(wallet => { if (!abort.signal.aborted && id === ticket.current && scopeRef.current === scope && current()) setState({ scope, wallet, error: null, loading: false }); }, error => { if (!abort.signal.aborted && id === ticket.current && scopeRef.current === scope && current()) fail(error); });
    return () => abort.abort();
  // The scope binds the stable user and identity version; old responses are checked against the store too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, reload]);
  const visible = state.scope === scope && current() ? state : { scope, wallet: null, error: null, loading: true };
  return { ...visible, refresh: () => setReload(n => n + 1), current, invalidate: fail, session };
}

export function WalletSummary({ scope }: { scope: string }) {
  const read = useWalletRead(scope);
  return <section className="account-wallet-preview" aria-labelledby="account-wallet-heading" aria-busy={read.loading || undefined}><div className="account-wallet-mark" aria-hidden="true"><CreditCard size={25} /></div><div><h2 id="account-wallet-heading">我的钱包</h2><strong data-testid="wallet-summary-amount">{read.loading ? "正在读取余额" : read.wallet ? walletMoney(read.wallet.buckets.available.amountCents) : "钱包暂时无法读取"}</strong><p>{read.wallet?.buckets.available.knowledge === "UNKNOWN" ? "可用金额尚未确认" : "可用余额与流水统一记录"}</p><Link href="/account?view=wallet" scroll={false}>查看钱包<ChevronRight size={13} aria-hidden="true" /></Link></div></section>;
}

const href = (pane = "overview", entry?: string, bucket: EntryBucket = "ALL") => { const q = new URLSearchParams({ view: "wallet" }); if (pane !== "overview") q.set("wallet", pane); if (entry) q.set("entry", entry); if (bucket !== "ALL") q.set("bucket", bucket); return "/account?" + q; };
const bucketLabel = (b: Exclude<EntryBucket,'ALL'>) => ({AVAILABLE:'余额',REFUND_PAYABLE:'待退款',RESERVED:'提现处理中',PENDING_EARNINGS:'待结算收益'})[b];
const errorText = (e: WalletRequestError | null) => e?.status === 401 ? "登录状态已变化，请重新登录。" : e?.status === 403 ? "暂时无法查看钱包，请确认账号状态。" : e?.status === 409 ? "流水已更新，请刷新后查看。" : "钱包暂时无法查看，请稍后重试。";
function entryDisplayTime(e:WalletEntry){return e.kind==='HISTORICAL'?{label:'发生时间',at:e.occurredAt}:Object.hasOwn(e,'postedAt')?{label:'入账时间',at:e.postedAt??null}:{label:'记录时间',at:e.occurredAt};}
function EntryRows({ items, bucket, onOpen }: { items: WalletEntry[]; bucket: EntryBucket; onOpen: (id: string) => void }) { return <div className="wallet-records">{items.map(e => {const display=entryDisplayTime(e);return <Link key={e.id} className="wallet-record" data-wallet-entry={e.id} href={href("entry", e.id, bucket)} scroll={false} onClick={() => onOpen(e.id)}><span className="wallet-record-time"><small>{display.label}</small><br/>{display.at?<time dateTime={display.at}>{formatOrderTime(display.at, { timeZoneName: false })}</time>:'待确认'}</span><span className="wallet-record-copy"><strong>{financeEntryLabel(e)}</strong><small>{e.sourceDetails?'业务往来':bucketLabel(e.bucket)}{(e.sourceDetails?.originalNumber??e.businessReference.number) ? ` · ${e.sourceDetails?.originalNumber??e.businessReference.number}` : ""}</small>{e.sourceDetails?.attempts?.map(a=><small key={'la_refund_log:'+a.source.id}>原尝试 {a.originalNumber??'原号待核'} · {walletMoney(a.recordedAmountCents)} · {refundAttemptStatus(a.originalStatus)}</small>)}</span><strong className="wallet-delta" data-direction={e.kind === "POSTED" && e.bucket === "AVAILABLE" && e.deltaCents !== "0" ? e.deltaCents.startsWith("-") ? "out" : "in" : undefined}>{walletMoney(e.sourceDetails?.recordedAmountCents??e.deltaCents, !e.sourceDetails)}</strong><RecordStatus tone={e.kind === "HISTORICAL" ? "neutral" : "success"}>{e.kind === "HISTORICAL" ? e.includedInOpening ? "已计入余额" : "仅供查看" : "已记账"}</RecordStatus><ChevronRight size={15} aria-hidden="true" /></Link>;})}</div>; }

export function PersonalWallet({ scope }: { scope: string }) {
  const params = useSearchParams(), paneRaw = params.get("wallet"), pane = ["entries", "entry", "withdraw", "withdraw-local", "guarantees"].includes(paneRaw ?? "") ? paneRaw! : "overview", entryId = params.get("entry") ?? "", filterRaw = params.get("bucket"), bucket: EntryBucket = ['AVAILABLE','REFUND_PAYABLE','RESERVED','PENDING_EARNINGS'].includes(filterRaw??'') ? filterRaw as EntryBucket : "ALL";
  const read = useWalletRead(scope), heading = useRef<HTMLHeadingElement>(null), root = useRef<HTMLElement>(null), scopeRef = useRef(scope); scopeRef.current = scope;
  const [detailReload, setDetailReload] = useState(0);
  const [page, setPage] = useState<{ scope: string; bucket: EntryBucket; value: WalletEntryPage | null; error: WalletRequestError | null; busy: boolean }>({ scope, bucket, value: null, error: null, busy: true });
  const [detail, setDetail] = useState<{ scope: string; id: string; value: WalletEntryDetail | null; error: WalletRequestError | null }>({ scope, id: entryId, value: null, error: null });
  const pageRequest = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null);
  const listPosition = useRef<{ scope: string; bucket: EntryBucket; y: number; entryId: string } | null>(null), queryRef = useRef({ scope, bucket }); queryRef.current = { scope, bucket };
  const visiblePage = page.scope === scope && page.bucket === bucket && read.current() ? page : { scope, bucket, value: null, error: null, busy: true };
  const visibleDetail = detail.scope === scope && detail.id === entryId && read.current() ? detail : { scope, id: entryId, value: null, error: null };
  useEffect(() => {
    const saved = listPosition.current;
    if (pane === "entries" && saved?.scope === scope && saved.bucket === bucket) {
      const row = Array.from(root.current?.querySelectorAll<HTMLAnchorElement>(".wallet-record") ?? []).find(link => link.dataset.walletEntry === saved.entryId);
      (row ?? heading.current)?.focus({ preventScroll: true });
      window.scrollTo({ top: saved.y, behavior: "instant" });
      listPosition.current = null;
    } else heading.current?.focus({ preventScroll: true });
    if (saved?.scope !== scope) listPosition.current = null;
  }, [pane, entryId, scope, bucket]);
  const rememberList = (id: string) => { if (read.current()) listPosition.current = { scope, bucket, y: window.scrollY, entryId: id }; };
  const loadPage = async (cursor: string | null) => {
    if (!read.current() || !read.session.userId || !read.wallet || queryRef.current.scope !== scope || queryRef.current.bucket !== bucket || visiblePage.busy && cursor) return;
    pageRequest.current?.abort(); const abort = new AbortController(); pageRequest.current = abort;
    const prior = cursor ? visiblePage.value : null; setPage({ scope, bucket, value: prior, error: null, busy: true });
    try { const next = await readMyWalletEntries(read.session.userId, bucket, cursor, abort.signal); if (abort.signal.aborted || scopeRef.current !== scope || pageRequest.current !== abort || !read.current()) return; if (next.snapshotVersion !== read.wallet.snapshotVersion || prior && (next.asOf !== prior.asOf || next.snapshotVersion !== prior.snapshotVersion || JSON.stringify(next.totals) !== JSON.stringify(prior.totals))) throw new WalletRequestError(409, "SNAPSHOT_CHANGED"); const ids = new Set(prior?.items.map(e => e.id)); if (cursor && next.items.some(e => ids.has(e.id))) throw new WalletRequestError(502, "FINANCE_CONTRACT_REQUIRED"); setPage({ scope, bucket, value: { ...next, items: [...(prior?.items ?? []), ...next.items] }, error: null, busy: false }); }
    catch (error) { if (abort.signal.aborted || scopeRef.current !== scope || pageRequest.current !== abort || !read.current()) return; const e = error instanceof WalletRequestError ? error : new WalletRequestError(0, "NETWORK_ERROR"); if (e.status === 401 || e.status === 403) { setPage({ scope, bucket, value: null, error: e, busy: false }); setDetail({ scope, id: entryId, value: null, error: null }); read.invalidate(e); } else setPage({ scope, bucket, value: e.status === 409 ? null : prior, error: e, busy: false }); }
  };
  useEffect(() => {
    setPage({ scope, bucket, value: null, error: null, busy: true });
    if (read.wallet) void loadPage(null);
    return () => { pageRequest.current?.abort(); };
  // Every reload or bucket change starts a new signed snapshot; continuation never silently switches it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, bucket, read.wallet]);
  useEffect(() => {
    const abort = new AbortController(); detailRequest.current?.abort(); detailRequest.current = abort; setDetail({ scope, id: entryId, value: null, error: null });
    if (pane !== "entry" || !entryId || !read.session.userId || !read.wallet || !read.current()) return () => abort.abort();
    readMyWalletEntry(read.session.userId, entryId, abort.signal).then(value => { if (!abort.signal.aborted && scopeRef.current === scope && read.current()) setDetail({ scope, id: entryId, value, error: null }); }, error => { if (abort.signal.aborted || scopeRef.current !== scope || !read.current()) return; const e = error instanceof WalletRequestError ? error : new WalletRequestError(0, "NETWORK_ERROR"); setDetail({ scope, id: entryId, value: null, error: e }); if (e.status === 401 || e.status === 403) read.invalidate(e); });
    return () => abort.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, pane, entryId, read.wallet, detailReload]);
  const refresh = () => { pageRequest.current?.abort(); detailRequest.current?.abort(); setPage({ scope, bucket, value: null, error: null, busy: true }); setDetail({ scope, id: entryId, value: null, error: null }); read.refresh(); };
  const title = pane === "entries" ? "余额流水" : pane === "entry" ? "流水详情" : pane === "withdraw" ? "银行卡与提现" : pane === "withdraw-local" ? "提现申请" : pane === "guarantees" ? "上架保证金" : "我的钱包";
  const w = read.wallet, records = visiblePage.value;
  const recordsComplete = records?.listCoverage.knowledge === "KNOWN" && records.listCoverage.scope !== "POSTED_LEDGER_ONLY";
  return <section ref={root} className="account-module personal-wallet" data-testid="personal-wallet" aria-busy={read.loading || undefined}>
    <header className="account-module-heading"><div><h2 ref={heading} tabIndex={-1} className="wallet-heading">{title}</h2><p>{pane === "withdraw" ? "管理收款资料，核对提现条件、费用与申请记录。" : "查看余额、提现和资金记录。"}</p></div>{pane !== "withdraw" && pane !== "guarantees" ? <button type="button" className="button secondary" disabled={read.loading} onClick={refresh}><RefreshCw size={15} aria-hidden="true" />刷新</button> : null}</header>
    <nav className="wallet-local-tabs" aria-label="钱包页面"><Link href={href()} scroll={false} aria-current={pane === "overview" ? "page" : undefined}>钱包概览</Link><Link href={href("entries")} scroll={false} aria-current={pane === "entries" || pane === "entry" ? "page" : undefined}>余额流水</Link><Link href={href("withdraw")} scroll={false} aria-current={pane === "withdraw" || pane === "withdraw-local" ? "page" : undefined}>提现</Link><Link href={href("guarantees")} scroll={false} aria-current={pane === "guarantees" ? "page" : undefined}>上架保证金</Link></nav>
    {pane === "guarantees" ? <><OwnerGuaranteeHistory scope={scope} /><p className="account-module-note">缴纳、退还和信用相关处理可前往 <Link className="account-inline-link" href="/account?view=credit" scroll={false}>信用与保证金</Link> 查看。</p></> : pane === "withdraw" ? <><ControlledWithdrawal key={`controlled:${scope}`} wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} compact showRecoveryFallback /><BankBindingWorkspace key={scope} scope={scope} availableBalance={w?.buckets.available.amountCents ?? null} onWalletChanged={refresh} /></> : pane === "withdraw-local" ? <><Link className="account-detail-back" href={href("withdraw")} scroll={false}>返回银行卡与提现</Link>{!w?<p role="status">余额暂时无法查看，你仍可查询提现记录。</p>:null}<ControlledWithdrawal key={`controlled:${scope}`} wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} /></> : read.loading ? <div className="account-module-card wallet-loading"><SkeletonBlock label="正在读取钱包" variant="amount" lines={4} /></div> : read.error || !w ? <div className="account-module-card account-empty-state" role="alert"><Info size={28} aria-hidden="true" /><h3>钱包暂时无法读取</h3><p>{errorText(read.error)}</p><button className="button secondary" type="button" onClick={refresh}>重试读取</button></div> : <>
      {pane === "overview" ? <><section className="account-module-card wallet-funds-summary" aria-label="余额"><div className="wallet-balance-pair"><div className="wallet-available"><Amount label="余额" size="hero" value={walletMoney(w.buckets.available.amountCents)} knowledge={w.buckets.available.knowledge === "UNKNOWN" ? "UNKNOWN" : "KNOWN"} testId="wallet-available-amount" data-wallet-bucket="available" note={w.buckets.available.knowledge === "UNKNOWN" ? "余额暂未确认，请稍后查看。" : undefined} /></div><Link className="button primary" href={href("withdraw")} scroll={false}>提现</Link></div></section><p className="account-module-note" role="status" data-testid="wallet-withdrawal-amount-note">{walletWithdrawalNote(w)}</p>
      <ControlledWithdrawal key={`controlled:${scope}`} wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} compact />
      <div className="wallet-section-heading"><h3>最近流水</h3><Link href={href("entries")} scroll={false}>全部流水<ChevronRight size={14} aria-hidden="true" /></Link></div>{records?.items.length ? <div className="account-module-card wallet-record-card"><EntryRows items={records.items.slice(0, 3)} bucket={records.bucket} onOpen={rememberList} /></div> : visiblePage.busy ? <p role="status">正在读取流水…</p> : visiblePage.error ? <div role="alert"><p>{errorText(visiblePage.error)}</p><button className="button secondary" onClick={() => void loadPage(null)}>重试流水</button></div> : <div className="account-module-card account-empty-state"><FileText size={26} aria-hidden="true" /><h3>{recordsComplete ? "暂无余额流水" : "流水记录尚待核对"}</h3><p>{recordsComplete ? "还没有可显示的流水。" : "部分流水仍在核对，请稍后查看。"}</p></div>}</> : null}
      {pane === "entries" ? <><details className="wallet-entry-filters" open={bucket !== "ALL" ? true : undefined}><summary>筛选记录{bucket !== "ALL" ? " · " + bucketLabel(bucket) : ""}</summary><nav className="wallet-local-tabs" aria-label="流水类型">{([["ALL", "全部"], ["AVAILABLE", "余额"], ["REFUND_PAYABLE", "待退款"], ["RESERVED", "提现处理中"], ["PENDING_EARNINGS", "待结算收益"]] as const).map(([value, label]) => <Link key={value} href={href("entries", undefined, value)} scroll={false} aria-current={bucket === value ? "page" : undefined}>{label}</Link>)}</nav></details>{records ? <>{!recordsComplete ? <p className="account-module-note" role="status">部分流水仍在核对，当前只显示已确认的记录。</p> : null}<div className="account-module-card wallet-record-card">{records.items.length ? <EntryRows items={records.items} bucket={records.bucket} onOpen={rememberList} /> : <div className="account-empty-state"><FileText size={28} /><h3>{recordsComplete ? "暂无流水" : "流水仍在核对"}</h3><p>{recordsComplete ? "可以切换其他类型查看。" : "请稍后再来查看。"}</p></div>}</div><p className="account-module-note">{!recordsComplete ? "已显示 " + records.items.length + " 条，部分记录仍在核对。" : "共 " + records.listCoverage.count + " 条记录"}</p></> : visiblePage.busy ? <p role="status">正在加载流水…</p> : null}{visiblePage.error ? <div className="wallet-read-error" role="alert"><LocalRetry message={errorText(visiblePage.error)} actionLabel="重试" onRetry={visiblePage.error.status === 409 ? refresh : () => void loadPage(records?.nextCursor ?? null)} /></div> : null}{records?.nextCursor ? <button className="button secondary wallet-load-more" disabled={visiblePage.busy} onClick={() => void loadPage(records.nextCursor)}>{visiblePage.busy ? "正在加载…" : "加载更多"}</button> : null}</> : null}
      {pane === "entry" ? <><Link className="account-detail-back" href={href("entries", undefined, bucket)} scroll={false}><ArrowLeft size={14} />返回余额流水</Link>{visibleDetail.error ? <div className="account-module-card account-empty-state" role="alert"><Info size={28} /><h3>{visibleDetail.error.status === 404 ? "未找到可读取的记录" : "流水暂时无法读取"}</h3>{visibleDetail.error.status === 404 ? <p>该记录不存在或不属于当前账号。</p> : <LocalRetry message={errorText(visibleDetail.error)} actionLabel="重试这笔记录" onRetry={() => setDetailReload(n => n + 1)} />}</div> : visibleDetail.value ? <EntryDetail detail={visibleDetail.value} /> : <p role="status">正在读取这笔记录…</p>}</> : null}
    </>}
  </section>;
}
function EntryDetail({ detail }: { detail: WalletEntryDetail }) {
 const e=detail.entry,display=entryDisplayTime(e);
 const note=e.kind==='HISTORICAL'?(e.includedInOpening?'这笔记录已包含在余额中，不会重复计算。':'这笔记录仅供查看，不会改变余额。'):null;
 return <article className="account-module-card wallet-entry-detail"><StatusBadge tone={e.kind === "HISTORICAL" ? "neutral" : "success"}>{e.kind === "HISTORICAL" ? e.includedInOpening ? "已计入余额" : "仅供查看" : "已记账"}</StatusBadge><h3>{financeEntryLabel(e)}</h3><strong className="wallet-main-amount">{walletMoney(e.sourceDetails?.recordedAmountCents??e.deltaCents, !e.sourceDetails)}</strong><dl className="account-fact-list"><div><dt>记录类型</dt><dd>{e.sourceDetails?'业务往来':bucketLabel(e.bucket)}</dd></div><div><dt>{display.label}</dt><dd>{display.at?formatOrderTime(display.at, { timeZoneName: false }):'待确认'}</dd></div>{Object.hasOwn(e,'recordedAt')?<div><dt>记录时间</dt><dd>{e.recordedAt?formatOrderTime(e.recordedAt,{timeZoneName:false}):'未记录'}</dd></div>:null}{e.sourceDetails?<>{walletOriginalType(e)?<div><dt>{e.sourceKind==='HISTORICAL_WITHDRAWAL'?'原提现方式':e.sourceKind==='HISTORICAL_PAYMENT'?'原业务类型':'原退款类型'}</dt><dd>{walletOriginalType(e)}</dd></div>:null}<div><dt>原平台状态</dt><dd>{walletSourceStatus(e)??'待确认'}</dd></div>{e.sourceDetails.associationState==='UNRESOLVED'?<div><dt>关联状态</dt><dd>原记录关联待核查</dd></div>:null}<div><dt>原记录单号</dt><dd>{e.sourceDetails.originalNumber??'尚未提供'}</dd></div>{e.sourceDetails.sourcePaidAt?<div><dt>{e.sourceKind==='HISTORICAL_DISTRIBUTION'?'原结算时间':'原支付时间'}</dt><dd>{formatOrderTime(e.sourceDetails.sourcePaidAt,{timeZoneName:false})}</dd></div>:null}{e.sourceDetails.attempts?.map(a=><div key={'la_refund_log:'+a.source.id}><dt>原退款尝试</dt><dd>{a.originalNumber??'原号待核'} · {walletMoney(a.recordedAmountCents)} · {refundAttemptStatus(a.originalStatus)}{a.occurredAt?' · '+formatOrderTime(a.occurredAt,{timeZoneName:false}):' · 时间待核'}</dd></div>)}{e.sourceDetails.reasonCodes?.length?<div><dt>原记录核对</dt><dd>同订单退款记录存在重复或金额待核事项，保留原记录等待核查。</dd></div>:null}<div><dt>资金含义</dt><dd>原平台业务记录，不改变当前钱包；渠道到账尚未核实。</dd></div>{e.sourceDetails.originalLevel?<div><dt>原分销层级与比例</dt><dd>{e.sourceDetails.originalLevel}级 · {e.sourceDetails.originalRatio??'待确认'}</dd></div>:null}</>:null}<div><dt>关联单号</dt><dd>{e.businessReference.number ?? "暂未提供"}</dd></div><div><dt>当时余额</dt><dd>{e.balanceAfterCents === null ? "尚未提供" : walletMoney(e.balanceAfterCents)}</dd></div></dl>{note?<p className="account-module-note">{note}</p>:null}</article>;
}
