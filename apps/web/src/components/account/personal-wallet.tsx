"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronRight, Clock3, CreditCard, FileText, Info, RefreshCw, ShieldCheck } from "lucide-react";
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
function BankChipSvg() {
  return (
    <svg className="bank-chip-svg" width="34" height="26" viewBox="0 0 36 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="36" height="28" rx="4" fill="url(#chip-grad)" />
      <rect x="0.5" y="0.5" width="35" height="27" rx="3.5" stroke="#D4AF37" strokeOpacity="0.4" />
      <path d="M0 10H12M0 18H12M24 10H36M24 18H36M12 10C12 14 12 14 12 18M24 10C24 14 24 14 24 18M12 14H24M18 0V10M18 18V28" stroke="#8C6D1F" strokeWidth="1" strokeOpacity="0.6" />
      <defs>
        <linearGradient id="chip-grad" x1="0" y1="0" x2="36" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F5D77F" />
          <stop offset="0.5" stopColor="#E5C158" />
          <stop offset="1" stopColor="#C99E32" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function useUserBankBinding(scope: string, userId?: string) {
  const [binding, setBinding] = useState<{ cardMask: string; holderNameMask: string } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    if (!userId) {
      setLoading(false);
      setBinding(null);
      return;
    }
    setLoading(true);
    fetch("/api/account/withdrawal-bank-binding", {
      headers: { "x-zzsh-expected-user-id": userId },
      credentials: "same-origin"
    })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!active) return;
        if (data?.binding?.cardMask) {
          setBinding({
            cardMask: data.binding.cardMask,
            holderNameMask: data.binding.holderNameMask ?? "持卡人"
          });
        } else {
          setBinding(null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setBinding(null);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [scope, userId]);
  return { binding, loading };
}

function EntryRows({ items, bucket, onOpen }: { items: WalletEntry[]; bucket: EntryBucket; onOpen: (id: string) => void }) {
  return (
    <div className="wallet-records">
      {items.map(e => {
        const display = entryDisplayTime(e);
        const isReference = Boolean(e.sourceDetails);
        const isRealBalance = e.kind === "POSTED" || (e.kind === "HISTORICAL" && e.includedInOpening);
        return (
          <Link
            key={e.id}
            className={`wallet-record ${isReference ? "is-reference" : "is-balance"}`}
            data-wallet-entry={e.id}
            href={href("entry", e.id, bucket)}
            scroll={false}
            onClick={() => onOpen(e.id)}
          >
            <span className="wallet-record-time">
              <small>{display.label}</small>
              <br />
              {display.at ? (
                <time dateTime={display.at}>{formatOrderTime(display.at, { timeZoneName: false })}</time>
              ) : (
                "待确认"
              )}
            </span>
            <span className="wallet-record-copy">
              <div className="wallet-record-title-row">
                <strong>{financeEntryLabel(e)}</strong>
                {isReference ? (
                  <span className="wallet-type-tag reference-tag">业务存据 · 仅供查验</span>
                ) : (
                  <span className="wallet-type-tag balance-tag">实际余额变动</span>
                )}
              </div>
              <small>
                {e.sourceDetails ? "业务往来" : bucketLabel(e.bucket)}
                {e.sourceDetails?.originalNumber ?? e.businessReference.number
                  ? ` · ${e.sourceDetails?.originalNumber ?? e.businessReference.number}`
                  : ""}
              </small>
              {e.sourceDetails?.attempts?.map(a => (
                <small key={"la_refund_log:" + a.source.id}>
                  原尝试 {a.originalNumber ?? "原号待核"} · {walletMoney(a.recordedAmountCents)} ·{" "}
                  {refundAttemptStatus(a.originalStatus)}
                </small>
              ))}
            </span>
            <div className="wallet-delta-container">
              <strong
                className="wallet-delta"
                data-direction={
                  e.kind === "POSTED" && e.bucket === "AVAILABLE" && e.deltaCents !== "0"
                    ? e.deltaCents.startsWith("-")
                      ? "out"
                      : "in"
                    : undefined
                }
              >
                {walletMoney(e.sourceDetails?.recordedAmountCents ?? e.deltaCents, !e.sourceDetails)}
              </strong>
              {isReference ? (
                <small className="wallet-delta-sub reference">原单存据 · 不变动余额</small>
              ) : isRealBalance ? (
                <small className="wallet-delta-sub balance">计入当前余额</small>
              ) : null}
            </div>
            <RecordStatus tone={e.kind === "HISTORICAL" ? "neutral" : "success"}>
              {e.kind === "HISTORICAL" ? (e.includedInOpening ? "已计入余额" : "仅供查看") : "已记账"}
            </RecordStatus>
            <ChevronRight size={15} aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}

export function PersonalWallet({ scope }: { scope: string }) {
  const params = useSearchParams(), paneRaw = params.get("wallet"), pane = ["entries", "entry", "withdraw", "withdraw-local", "guarantees"].includes(paneRaw ?? "") ? paneRaw! : "overview", entryId = params.get("entry") ?? "", filterRaw = params.get("bucket"), bucket: EntryBucket = ['AVAILABLE','REFUND_PAYABLE','RESERVED','PENDING_EARNINGS'].includes(filterRaw??'') ? filterRaw as EntryBucket : "ALL";
  const read = useWalletRead(scope), heading = useRef<HTMLHeadingElement>(null), root = useRef<HTMLElement>(null), scopeRef = useRef(scope); scopeRef.current = scope;
  const bankCard = useUserBankBinding(scope, read.session.userId);
  const [detailReload, setDetailReload] = useState(0);
  const [filterOnlyReal, setFilterOnlyReal] = useState(false);
  const [timeRange, setTimeRange] = useState<"ALL" | "7D" | "30D">("ALL");
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
  const rawItems = records?.items ?? [];
  const displayItems = rawItems.filter(e => {
    if (filterOnlyReal && !(e.kind === "POSTED" || (e.kind === "HISTORICAL" && e.includedInOpening))) return false;
    if (timeRange !== "ALL") {
      const rawTime = e.occurredAt ?? (Object.hasOwn(e, "postedAt") ? (e as { postedAt?: string | null }).postedAt : null);
      if (rawTime) {
        const diffDays = (Date.now() - new Date(rawTime).getTime()) / (1000 * 3600 * 24);
        if (timeRange === "7D" && diffDays > 7) return false;
        if (timeRange === "30D" && diffDays > 30) return false;
      }
    }
    return true;
  });
  return <section ref={root} className="account-module personal-wallet" data-testid="personal-wallet" aria-busy={read.loading || undefined}>
    <header className="account-module-heading"><div><h2 ref={heading} tabIndex={-1} className="wallet-heading">{title}</h2><p>{pane === "withdraw" ? "管理收款资料，核对提现条件、费用与申请记录。" : "查看余额、提现和资金记录。"}</p></div>{pane !== "withdraw" && pane !== "guarantees" ? <button type="button" className="button secondary" disabled={read.loading} onClick={refresh}><RefreshCw size={15} aria-hidden="true" />刷新</button> : null}</header>
    <nav className="wallet-local-tabs" aria-label="钱包页面">
      <Link href={href()} scroll={false} aria-current={pane === "overview" ? "page" : undefined}>钱包概览</Link>
      <Link href={href("entries")} scroll={false} aria-current={pane === "entries" || pane === "entry" ? "page" : undefined}>余额流水</Link>
      <Link href={href("withdraw")} scroll={false} aria-current={pane === "withdraw" || pane === "withdraw-local" ? "page" : undefined}>提现</Link>
    </nav>
    {pane === "guarantees" ? <>
      <OwnerGuaranteeHistory scope={scope} />
      <p className="account-module-note">缴纳、退还和信用相关处理可前往 <Link className="account-inline-link" href="/account?view=credit" scroll={false}>信用与保证金</Link> 查看。</p>
    </> : pane === "withdraw" ? <>
      <ControlledWithdrawal key={`controlled:${scope}`} wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} compact showRecoveryFallback />
      <BankBindingWorkspace key={scope} scope={scope} availableBalance={w?.buckets.available.amountCents ?? null} onWalletChanged={refresh} />
    </> : pane === "withdraw-local" ? <>
      <Link className="account-detail-back" href={href("withdraw")} scroll={false}>返回银行卡与提现</Link>
      {!w ? <p role="status">余额暂时无法查看，你仍可查询提现记录。</p> : null}
      <ControlledWithdrawal key={`controlled:${scope}`} wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} />
    </> : read.loading ? <div className="account-module-card wallet-loading"><SkeletonBlock label="正在读取钱包" variant="amount" lines={4} /></div> : read.error || !w ? <div className="account-module-card account-empty-state" role="alert"><Info size={28} aria-hidden="true" /><h3>钱包暂时无法读取</h3><p>{errorText(read.error)}</p><button className="button secondary" type="button" onClick={refresh}>重试读取</button></div> : <>
      {pane === "overview" ? <>
        {/* 仅在有待确认提现申请或异常时渲染待处理横幅，平时为 null */}
        <ControlledWithdrawal key={`controlled:${scope}`} wallet={w} scope={scope} onWalletChanged={refresh} onIdentityFailure={read.invalidate} compact />

        <div className="wallet-overview-top-grid">
          {/* Card 1: 账户可用余额 */}
          <section className="account-module-card wallet-funds-summary wallet-overview-card" aria-label="余额">
            <div className="wallet-card-header">
              <div className="wallet-card-title-group">
                <CreditCard size={18} className="wallet-card-header-icon" aria-hidden="true" />
                <span className="wallet-card-title">账户可用余额</span>
              </div>
              <span className="wallet-badge-pill">实时记账</span>
            </div>
            <div className="wallet-balance-content">
              <div className="wallet-available">
                <Amount label="余额" size="hero" value={walletMoney(w.buckets.available.amountCents)} knowledge={w.buckets.available.knowledge === "UNKNOWN" ? "UNKNOWN" : "KNOWN"} testId="wallet-available-amount" data-wallet-bucket="available" note={w.buckets.available.knowledge === "UNKNOWN" ? "余额暂未确认，请稍后查看。" : undefined} />
              </div>
              <p className="wallet-balance-subhint">支持提现至本人借记卡 · 银联渠道清算</p>
              <div className="wallet-card-actions">
                <Link className="button primary wallet-withdraw-btn" href={href("withdraw")} scroll={false}>提现</Link>
                <Link className="button secondary wallet-entries-btn" href={href("entries")} scroll={false}>查看流水</Link>
              </div>
            </div>
          </section>

          {/* Card 2: 收款银行卡 (PaymentCard 仿真实名借记卡) */}
          <section className="account-module-card wallet-overview-card wallet-bank-card-container" aria-label="收款银行卡">
            <div className="wallet-card-header">
              <div className="wallet-card-title-group">
                <CreditCard size={18} className="wallet-card-header-icon" aria-hidden="true" />
                <span className="wallet-card-title">收款银行卡</span>
              </div>
              <Link href={href("withdraw")} scroll={false} className="wallet-card-header-link">
                {bankCard.binding ? "管理卡片" : "去绑卡"}
              </Link>
            </div>
            <div className="wallet-bank-card-body">
              {bankCard.loading ? (
                <div className="bank-card-skeleton">
                  <SkeletonBlock label="正在核对收款银行卡" lines={2} />
                </div>
              ) : bankCard.binding ? (
                <div className="bank-card-realistic">
                  <svg className="bank-card-waves" viewBox="0 0 320 200" fill="none" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M-20 130 C 80 80, 160 180, 340 90" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.12" fill="none" />
                    <path d="M-10 160 C 90 110, 180 210, 350 120" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.08" fill="none" />
                    <circle cx="270" cy="40" r="70" fill="url(#card-glow-overview)" opacity="0.15" />
                    <defs>
                      <radialGradient id="card-glow-overview" cx="50%" cy="50%" r="50%">
                        <stop stopColor="#F5D77F" />
                        <stop offset="100%" stopColor="transparent" />
                      </radialGradient>
                    </defs>
                  </svg>
                  <div className="bank-card-top">
                    <span className="bank-card-network">银联借记卡</span>
                    <BankChipSvg />
                  </div>
                  <div className="bank-card-number">{bankCard.binding.cardMask}</div>
                  <div className="bank-card-bottom">
                    <div className="bank-card-holder">
                      <span className="bank-card-label">持卡人</span>
                      <span className="bank-card-name">{bankCard.binding.holderNameMask}</span>
                    </div>
                    <span className="bank-card-bound-badge">已绑定托管</span>
                  </div>
                </div>
              ) : (
                <div className="bank-card-unbound-slot">
                  <div className="unbound-slot-icon" aria-hidden="true">
                    <CreditCard size={22} />
                  </div>
                  <div className="unbound-slot-copy">
                    <strong>尚未绑定收款银行卡</strong>
                    <p>绑定本人借记卡后，余额可快速提现到账</p>
                  </div>
                  <Link href={href("withdraw")} scroll={false} className="button primary unbound-slot-cta">
                    立即绑定银行卡
                  </Link>
                </div>
              )}
            </div>
          </section>
        </div>

        <p className="account-module-note wallet-withdrawal-global-note" role="status" data-testid="wallet-withdrawal-amount-note">{walletWithdrawalNote(w)}</p>

        {/* 通栏展示 Invoices Table 风格的资金动态 (已彻底移除噪音卡片) */}
        <div className="wallet-overview-table-section">
          <div className="wallet-section-heading">
            <div>
              <h3>最近资金动态</h3>
              <p className="wallet-section-subtitle">展示最新交易流水，完整记录请查看全部流水</p>
            </div>
            <Link href={href("entries")} scroll={false} className="wallet-view-all-link">全部流水<ChevronRight size={14} aria-hidden="true" /></Link>
          </div>
          {records?.items.length ? (
            <div className="account-module-card wallet-table-card">
              <div className="wallet-table-header" aria-hidden="true">
                <span className="th-col th-time">时间</span>
                <span className="th-col th-desc">业务类型与单号</span>
                <span className="th-col th-amount">发生金额</span>
                <span className="th-col th-status">记录状态</span>
                <span className="th-col th-action"></span>
              </div>
              <div className="wallet-table-body">
                <EntryRows items={records.items.slice(0, 5)} bucket={records.bucket} onOpen={rememberList} />
              </div>
            </div>
          ) : visiblePage.busy ? (
            <p role="status">正在读取流水…</p>
          ) : visiblePage.error ? (
            <div role="alert"><p>{errorText(visiblePage.error)}</p><button className="button secondary" onClick={() => void loadPage(null)}>重试流水</button></div>
          ) : (
            <div className="account-module-card account-empty-state"><FileText size={26} aria-hidden="true" /><h3>{recordsComplete ? "暂无余额流水" : "流水记录尚待核对"}</h3><p>{recordsComplete ? "还没有可显示的流水。" : "部分流水仍在核对，请稍后查看。"}</p></div>
          )}
        </div>
      </> : null}
      {pane === "entries" ? <>
        <div className="wallet-filter-container">
          <div className="wallet-filter-header">
            <span className="wallet-filter-label">记录类别</span>
            <nav className="wallet-filter-pills" aria-label="流水类型">
              {([["ALL", "全部"], ["AVAILABLE", "余额变动"], ["REFUND_PAYABLE", "待退款"], ["RESERVED", "提现处理中"], ["PENDING_EARNINGS", "待结算收益"]] as const).map(([value, label]) =>
                <Link key={value} className="wallet-filter-pill" href={href("entries", undefined, value)} scroll={false} aria-current={bucket === value ? "page" : undefined}>{label}</Link>
              )}
            </nav>
          </div>
          <div className="wallet-filter-secondary">
            <div className="wallet-filter-quick-toggles">
              <button
                type="button"
                className={`wallet-toggle-chip ${filterOnlyReal ? "active" : ""}`}
                onClick={() => setFilterOnlyReal(v => !v)}
              >
                仅看实际变动
              </button>
              <button
                type="button"
                className={`wallet-toggle-chip ${timeRange === "ALL" ? "active" : ""}`}
                onClick={() => setTimeRange("ALL")}
              >
                全部时间
              </button>
              <button
                type="button"
                className={`wallet-toggle-chip ${timeRange === "30D" ? "active" : ""}`}
                onClick={() => setTimeRange("30D")}
              >
                近30天
              </button>
              <button
                type="button"
                className={`wallet-toggle-chip ${timeRange === "7D" ? "active" : ""}`}
                onClick={() => setTimeRange("7D")}
              >
                近7天
              </button>
            </div>
          </div>
        </div>
        {records ? <>
          {!recordsComplete ? <p className="account-module-note" role="status">部分流水仍在核对，当前只显示已确认的记录。</p> : null}
          <div className="account-module-card wallet-table-card">
            <div className="wallet-table-header" aria-hidden="true">
              <span className="th-col th-time">时间</span>
              <span className="th-col th-desc">业务类型与单号</span>
              <span className="th-col th-amount">发生金额</span>
              <span className="th-col th-status">记录状态</span>
              <span className="th-col th-action"></span>
            </div>
            <div className="wallet-table-body">
              {displayItems.length ? <EntryRows items={displayItems} bucket={records.bucket} onOpen={rememberList} /> : <div className="account-empty-state"><FileText size={28} /><h3>{recordsComplete ? "暂无流水" : "流水仍在核对"}</h3><p>{recordsComplete ? "可以切换其他类型查看。" : "请稍后再来查看。"}</p></div>}
            </div>
          </div>
          <div className="wallet-records-footer">
            <p className="account-module-note">{!recordsComplete ? "已显示 " + displayItems.length + " 条，部分记录仍在核对。" : "共 " + displayItems.length + " 条记录"}</p>
            {records?.nextCursor ? <button className="button secondary wallet-load-more" disabled={visiblePage.busy} onClick={() => void loadPage(records.nextCursor)}>{visiblePage.busy ? "正在加载…" : "加载更多流水记录"}</button> : null}
          </div>
        </> : visiblePage.busy ? <p role="status">正在加载流水…</p> : null}
        {visiblePage.error ? <div className="wallet-read-error" role="alert"><LocalRetry message={errorText(visiblePage.error)} actionLabel="重试" onRetry={visiblePage.error.status === 409 ? refresh : () => void loadPage(records?.nextCursor ?? null)} /></div> : null}
      </> : null}
      {pane === "entry" ? <><Link className="account-detail-back" href={href("entries", undefined, bucket)} scroll={false}><ArrowLeft size={14} />返回余额流水</Link>{visibleDetail.error ? <div className="account-module-card account-empty-state" role="alert"><Info size={28} /><h3>{visibleDetail.error.status === 404 ? "未找到可读取的记录" : "流水暂时无法读取"}</h3>{visibleDetail.error.status === 404 ? <p>该记录不存在或不属于当前账号。</p> : <LocalRetry message={errorText(visibleDetail.error)} actionLabel="重试这笔记录" onRetry={() => setDetailReload(n => n + 1)} />}</div> : visibleDetail.value ? <EntryDetail detail={visibleDetail.value} /> : <p role="status">正在读取这笔记录…</p>}</> : null}
    </>}
  </section>;
}
function EntryDetail({ detail }: { detail: WalletEntryDetail }) {
 const e=detail.entry,display=entryDisplayTime(e);
 const isReference = Boolean(e.sourceDetails);
 const note=e.kind==='HISTORICAL'?(e.includedInOpening?'这笔记录已包含在余额中，不会重复计算。':'这笔记录仅供查看，不会改变余额。'):null;
 return <article className="account-module-card wallet-entry-detail">
   <div className="wallet-entry-detail-header">
     <StatusBadge tone={e.kind === "HISTORICAL" ? "neutral" : "success"}>{e.kind === "HISTORICAL" ? e.includedInOpening ? "已计入余额" : "仅供查看" : "已记账"}</StatusBadge>
     {isReference ? <span className="wallet-type-tag reference-tag">业务存据 · 仅供查验</span> : <span className="wallet-type-tag balance-tag">实际余额变动</span>}
   </div>
   <h3>{financeEntryLabel(e)}</h3>
   <strong className="wallet-main-amount">{walletMoney(e.sourceDetails?.recordedAmountCents??e.deltaCents, !e.sourceDetails)}</strong>
   {isReference ? <p className="wallet-detail-nature-hint">此记录为历史业务发生凭证，原单金额不影响或重复计入当前可用余额。</p> : null}
   <dl className="account-fact-list">
     <div><dt>记录类型</dt><dd>{e.sourceDetails?'业务往来':bucketLabel(e.bucket)}</dd></div>
     <div><dt>{display.label}</dt><dd>{display.at?formatOrderTime(display.at, { timeZoneName: false }):'待确认'}</dd></div>
     {Object.hasOwn(e,'recordedAt')?<div><dt>记录时间</dt><dd>{e.recordedAt?formatOrderTime(e.recordedAt,{timeZoneName:false}):'未记录'}</dd></div>:null}
     {e.sourceDetails?<>{walletOriginalType(e)?<div><dt>{e.sourceKind==='HISTORICAL_WITHDRAWAL'?'原提现方式':e.sourceKind==='HISTORICAL_PAYMENT'?'原业务类型':'原退款类型'}</dt><dd>{walletOriginalType(e)}</dd></div>:null}
     <div><dt>原平台状态</dt><dd>{walletSourceStatus(e)??'待确认'}</dd></div>
     {e.sourceDetails.associationState==='UNRESOLVED'?<div><dt>关联状态</dt><dd>原记录关联待核查</dd></div>:null}
     <div><dt>原记录单号</dt><dd>{e.sourceDetails.originalNumber??'尚未提供'}</dd></div>
     {e.sourceDetails.sourcePaidAt?<div><dt>{e.sourceKind==='HISTORICAL_DISTRIBUTION'?'原结算时间':'原支付时间'}</dt><dd>{formatOrderTime(e.sourceDetails.sourcePaidAt,{timeZoneName:false})}</dd></div>:null}
     {e.sourceDetails.attempts?.map(a=><div key={'la_refund_log:'+a.source.id}><dt>原退款尝试</dt><dd>{a.originalNumber??'原号待核'} · {walletMoney(a.recordedAmountCents)} · {refundAttemptStatus(a.originalStatus)}{a.occurredAt?' · '+formatOrderTime(a.occurredAt,{timeZoneName:false}):' · 时间待核'}</dd></div>)}
     {e.sourceDetails.reasonCodes?.length?<div><dt>原记录核对</dt><dd>同订单退款记录存在重复或金额待核事项，保留原记录等待核查。</dd></div>:null}
     <div><dt>资金含义</dt><dd>原平台业务记录，不改变当前钱包；渠道到账尚未核实。</dd></div>
     {e.sourceDetails.originalLevel?<div><dt>原分销层级与比例</dt><dd>{e.sourceDetails.originalLevel}级 · {e.sourceDetails.originalRatio??'待确认'}</dd></div>:null}</>:null}
     <div><dt>关联单号</dt><dd>{e.businessReference.number ?? "暂未提供"}</dd></div>
     <div><dt>当时余额</dt><dd>{e.balanceAfterCents === null ? "尚未提供" : walletMoney(e.balanceAfterCents)}</dd></div>
   </dl>
   {note?<p className="account-module-note">{note}</p>:null}
 </article>;
}
