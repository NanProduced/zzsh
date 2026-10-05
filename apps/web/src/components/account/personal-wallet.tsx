"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Clock3, CreditCard, FileText, Info, RefreshCw } from "lucide-react";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { formatOrderTime } from "@/lib/order-client";
import { financeEntryLabel, readMyWallet, readMyWalletEntries, readMyWalletEntry, walletMoney, WalletRequestError, type EntryBucket, type WalletRead, type WalletEntry, type WalletEntryPage, type WalletEntryDetail } from "@/lib/personal-wallet-client";
import "./personal-wallet.css";
import {ControlledWithdrawal} from './controlled-withdrawal';

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
const bucketLabel = (b: "AVAILABLE" | "REFUND_PAYABLE") => b === "AVAILABLE" ? "可用余额" : "应退订单款";
const errorText = (e: WalletRequestError | null) => e?.status === 401 ? "登录身份已变化，请重新确认登录后读取。" : e?.status === 403 ? "当前身份无权读取钱包，请确认账号状态。" : e?.status === 409 ? "资金记录已变化，请重新读取当前流水。" : "钱包暂时无法读取，请重试。未确认的金额不会显示为零。";
function EntryRows({ items, bucket, onOpen }: { items: WalletEntry[]; bucket: EntryBucket; onOpen: () => void }) { return <div className="wallet-records">{items.map(e => <Link key={e.id} className="wallet-record" href={href("entry", e.id, bucket)} scroll={false} onClick={onOpen}><span className="wallet-record-mark"><FileText size={18} aria-hidden="true" /></span><span className="wallet-record-copy"><strong>{financeEntryLabel(e)}</strong><small>{formatOrderTime(e.occurredAt)}{e.businessReference.number ? ` · ${e.businessReference.number}` : ""}</small></span><strong className="wallet-delta" data-direction={e.deltaCents.startsWith("-") ? "out" : "in"}>{walletMoney(e.deltaCents, true)}</strong><span className="wallet-tag">{e.kind === "HISTORICAL" ? e.includedInOpening ? "已含期初" : "仅历史记录" : "已记账"}</span><ChevronRight size={15} aria-hidden="true" /></Link>)}</div>; }

export function PersonalWallet({ scope }: { scope: string }) {
  const params = useSearchParams(), paneRaw = params.get("wallet"), pane = ["entries", "entry", "withdraw"].includes(paneRaw ?? "") ? paneRaw! : "overview", entryId = params.get("entry") ?? "", filterRaw = params.get("bucket"), bucket: EntryBucket = filterRaw === "AVAILABLE" || filterRaw === "REFUND_PAYABLE" ? filterRaw : "ALL";
  const read = useWalletRead(scope), heading = useRef<HTMLHeadingElement>(null), scopeRef = useRef(scope); scopeRef.current = scope;
  const [page, setPage] = useState<{ scope: string; bucket: EntryBucket; value: WalletEntryPage | null; error: WalletRequestError | null; busy: boolean }>({ scope, bucket, value: null, error: null, busy: true });
  const [detail, setDetail] = useState<{ scope: string; id: string; value: WalletEntryDetail | null; error: WalletRequestError | null }>({ scope, id: entryId, value: null, error: null });
  const pageRequest = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null);
  const listPosition = useRef<{ scope: string; bucket: EntryBucket; y: number } | null>(null), queryRef = useRef({ scope, bucket }); queryRef.current = { scope, bucket };
  const visiblePage = page.scope === scope && page.bucket === bucket && read.current() ? page : { scope, bucket, value: null, error: null, busy: true };
  const visibleDetail = detail.scope === scope && detail.id === entryId && read.current() ? detail : { scope, id: entryId, value: null, error: null };
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [pane, entryId]);
  useEffect(() => { const saved = listPosition.current; if (pane === "entries" && saved?.scope === scope && saved.bucket === bucket) window.scrollTo({ top: saved.y, behavior: "instant" }); if (saved?.scope !== scope) listPosition.current = null; }, [pane, scope, bucket]);
  const rememberList = () => { if (read.current()) listPosition.current = { scope, bucket, y: window.scrollY }; };
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
  }, [scope, pane, entryId, read.wallet]);
  const refresh = () => { pageRequest.current?.abort(); detailRequest.current?.abort(); setPage({ scope, bucket, value: null, error: null, busy: true }); setDetail({ scope, id: entryId, value: null, error: null }); read.refresh(); };
  const title = pane === "entries" ? "余额流水" : pane === "entry" ? "流水详情" : pane === "withdraw" ? "提现" : "我的钱包";
  const w = read.wallet, records = visiblePage.value;
  return <section className="account-module personal-wallet" data-testid="personal-wallet" aria-busy={read.loading || undefined}>
    <header className="account-module-heading"><div><h2 ref={heading} tabIndex={-1} className="wallet-heading">{title}</h2><p>可用资金与处理状态分别展示，每笔变化保留原始记录。</p></div><button type="button" className="button secondary" disabled={read.loading} onClick={refresh}><RefreshCw size={15} aria-hidden="true" />重新读取</button></header>
    <nav className="wallet-local-tabs" aria-label="钱包页面"><Link href={href()} scroll={false} aria-current={pane === "overview" ? "page" : undefined}>钱包概览</Link><Link href={href("entries")} scroll={false} aria-current={pane === "entries" || pane === "entry" ? "page" : undefined}>余额流水</Link><Link href={href("withdraw")} scroll={false} aria-current={pane === "withdraw" ? "page" : undefined}>提现</Link></nav>
    {read.loading ? <div className="account-module-card account-empty-state" role="status"><CreditCard size={28} aria-hidden="true" /><h3>正在读取钱包</h3><p>金额确认后会显示在这里。</p></div> : read.error || !w ? <div className="account-module-card account-empty-state" role="alert"><Info size={28} aria-hidden="true" /><h3>钱包暂时无法读取</h3><p>{errorText(read.error)}</p><button className="button secondary" type="button" onClick={refresh}>重试读取</button></div> : <>
      {pane === "overview" ? <><div className="wallet-workbench"><section className="account-module-card wallet-available"><h3><CreditCard size={17} aria-hidden="true" />可用余额</h3><strong className="wallet-main-amount" data-testid="wallet-available-amount">{walletMoney(w.buckets.available.amountCents)}</strong><p>{w.buckets.available.knowledge === "KNOWN" ? "已核定并进入钱包的可用资金。" : "当前可用金额尚未确认，不会按零余额展示。"}</p><Link className="button primary" href={href("withdraw")} scroll={false}>查看提现条件</Link></section><ControlledWithdrawal wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} compact /></div>
      <dl className="wallet-other-funds">{([["reserved", "提现冻结", "已冻结的资金不可重复提现"], ["restricted", "受限资金", "限制原因确认后单独展示"], ["pendingEarnings", "邀请待结算", "尚未进入可用余额"]] as const).map(([k, name, note]) => <div key={k}><dt>{name}</dt><dd>{walletMoney(w.buckets[k].amountCents)}</dd><p>{note}</p></div>)}</dl>
      <div className="wallet-section-heading"><h3>最近流水</h3><Link href={href("entries")} scroll={false}>全部流水<ChevronRight size={14} aria-hidden="true" /></Link></div>{records?.items.length ? <div className="account-module-card wallet-record-card"><EntryRows items={records.items.slice(0, 3)} bucket={records.bucket} onOpen={rememberList} /></div> : visiblePage.busy ? <p role="status">正在读取流水…</p> : visiblePage.error ? <div role="alert"><p>{errorText(visiblePage.error)}</p><button className="button secondary" onClick={() => void loadPage(null)}>重试流水</button></div> : <div className="account-module-card account-empty-state"><FileText size={26} aria-hidden="true" /><h3>暂无余额流水</h3><p>这是当前读取结果，不代表其他资金状态已确认。</p></div>}<p className="account-module-note">应退订单款单独记录，不计入钱包可提现金额；当前{walletMoney(w.buckets.refundPayable.amountCents)}。读取于 {formatOrderTime(w.asOf)}。</p></> : null}
      {pane === "withdraw" ? <ControlledWithdrawal wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} /> : null}
      {pane === "entries" ? <><nav className="wallet-local-tabs" aria-label="流水资金类型">{([["ALL", "全部"], ["AVAILABLE", "可用余额"], ["REFUND_PAYABLE", "应退订单款"]] as const).map(([value, label]) => <Link key={value} href={href("entries", undefined, value)} scroll={false} aria-current={bucket === value ? "page" : undefined}>{label}</Link>)}</nav>{records ? <><p className="wallet-history-note">{records.totals.historicalCoverage === "INCLUDED" ? "旧平台记录已包含在期初余额，不会再次计入钱包。" : records.totals.historicalCoverage === "MIXED" ? "部分历史记录已含期初；其余仅作历史查询，不增加当前余额。" : "历史记录用于追溯，不会因展示再次计入余额。"}</p><div className="account-module-card wallet-record-card">{records.items.length ? <EntryRows items={records.items} bucket={records.bucket} onOpen={rememberList} /> : <div className="account-empty-state"><FileText size={28} /><h3>当前类型暂无流水</h3><p>可切换其他资金类型查看。</p></div>}</div><dl className="wallet-period-totals">{records.totals.byBucket.map(t => <div key={t.bucket}><dt>{bucketLabel(t.bucket)} · 本次快照</dt><dd>已记账净变动 {walletMoney(t.postedNetCents, true)}</dd><small>已含期初的历史净额 {walletMoney(t.coveredHistoricalNetCents, true)} · 未含期初 {walletMoney(t.uncoveredHistoricalNetCents, true)}</small></div>)}</dl><p className="account-module-note">已显示 {records.items.length} / {records.totals.count} 条 · 读取于 {formatOrderTime(records.asOf)}</p></> : visiblePage.busy ? <p role="status">正在读取流水…</p> : null}{visiblePage.error ? <div className="wallet-read-error" role="alert"><p>{errorText(visiblePage.error)}</p><button className="button secondary" onClick={visiblePage.error.status === 409 ? refresh : () => void loadPage(records?.nextCursor ?? null)}>重试读取</button></div> : null}{records?.nextCursor ? <button className="button secondary wallet-load-more" disabled={visiblePage.busy} onClick={() => void loadPage(records.nextCursor)}>{visiblePage.busy ? "正在读取…" : "加载更多"}</button> : null}</> : null}
      {pane === "entry" ? <><Link className="account-detail-back" href={href("entries", undefined, bucket)} scroll={false}><ArrowLeft size={14} />返回余额流水</Link>{visibleDetail.error ? <div className="account-module-card account-empty-state" role="alert"><Info size={28} /><h3>{visibleDetail.error.status === 404 ? "未找到可读取的记录" : "流水暂时无法读取"}</h3><p>{visibleDetail.error.status === 404 ? "该记录不存在或不属于当前账号。" : errorText(visibleDetail.error)}</p></div> : visibleDetail.value ? <EntryDetail detail={visibleDetail.value} /> : <p role="status">正在读取这笔记录…</p>}</> : null}
    </>}
  </section>;
}
function EntryDetail({ detail }: { detail: WalletEntryDetail }) { const e = detail.entry; return <article className="account-module-card wallet-entry-detail"><span className="wallet-tag">{e.kind === "HISTORICAL" ? e.includedInOpening ? "历史记录 · 已含期初" : "历史记录 · 未含期初" : "已记账"}</span><h3>{financeEntryLabel(e)}</h3><strong className="wallet-main-amount">{walletMoney(e.deltaCents, true)}</strong><dl className="account-fact-list"><div><dt>影响资金</dt><dd>{bucketLabel(e.bucket)}</dd></div><div><dt>原发生时间</dt><dd>{formatOrderTime(e.occurredAt)}</dd></div><div><dt>入库时间</dt><dd>{formatOrderTime(e.importedAt)}</dd></div><div><dt>来源</dt><dd>{e.source.type === "LEGACY_MYSQL" ? "旧平台来源" : e.source.type === "NATIVE" ? "本平台业务" : "来源待确认"}</dd></div><div><dt>关联单号</dt><dd>{e.businessReference.number ?? "尚未确认"}</dd></div>{e.balanceAfterCents !== null ? <div><dt>原记录余额</dt><dd>{walletMoney(e.balanceAfterCents)}</dd></div> : null}</dl><p className="account-module-note">{e.kind === "HISTORICAL" ? e.includedInOpening ? "这笔历史记录已在期初余额中，不会重复入账。原记录余额不代表当前钱包余额。" : "这笔记录仅供历史追溯，不增加当前钱包余额。" : "这笔金额已按资金类型记账。更正另有记录，不覆盖原流水。"}</p></article>; }
