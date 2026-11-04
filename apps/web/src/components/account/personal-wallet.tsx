"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronRight, Clock3, CreditCard, FileText, Info, RefreshCw, ShieldCheck } from "lucide-react";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";
import { formatOrderTime } from "@/lib/order-client";
import { walletWithdrawalNote, financeEntryLabel, walletSourceStatus,refundAttemptStatus,walletOriginalType, readMyWallet, readMyWalletEntries, readMyWalletEntry, walletMoney, WalletRequestError, type EntryBucket, type WalletRead, type WalletEntry, type WalletEntryPage, type WalletEntryDetail } from "@/lib/personal-wallet-client";
import { readBankBinding, type BankBinding } from "@/lib/withdrawal-bank-binding-client";
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
/** 只有金额真的变了才是"余额变动"；旧平台的业务记录只是旁证，不改余额。 */
function entryNature(e: WalletEntry) {
  if (e.sourceDetails) return { reference: true, label: "旧平台记录", note: "不影响余额" };
  if (e.bucket !== "AVAILABLE") return { reference: false, label: bucketLabel(e.bucket), note: "" };
  return { reference: false, label: "余额变动", note: "" };
}
/** 状态只用四个词：已入账 / 已扣除 / 处理中 / 已完成。旧平台旁证不冒充余额状态。 */
function entryStatus(e: WalletEntry): string | null {
  if (e.sourceDetails) return null;
  if (e.bucket === "RESERVED") return "处理中";
  if (e.bucket !== "AVAILABLE") return "已入账";
  return e.deltaCents.startsWith("-") ? "已扣除" : "已入账";
}
/** 空列表要说清"这里为什么空、去哪里看"，不写"仍在核对"。 */
const BUCKET_EMPTY: Record<Exclude<EntryBucket, "ALL">, { title: string; body: string; href: string; action: string }> = {
  AVAILABLE: { title: "暂无余额变动", body: "余额增加或扣减会显示在这里。", href: "/account?view=wallet", action: "返回钱包概览" },
  REFUND_PAYABLE: { title: "暂无待退款", body: "退款进度在对应订单里查看。", href: "/account?view=rentals", action: "去看订单" },
  RESERVED: { title: "暂无处理中的提现", body: "提现申请与到账进度在提现页查看。", href: "/account?view=wallet&wallet=withdraw", action: "去提现页" },
  PENDING_EARNINGS: { title: "暂无待结算收益", body: "佣金记录在邀请与佣金页查看。", href: "/account?view=invite", action: "去看佣金" },
};
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

function useUserBankBinding(scope: string, enabled: boolean, userId: string | null | undefined, reload: number) {
  const session = useUserSession(), store = useUserSessionStore();
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "unknown"; binding: BankBinding | null }>({ scope, status: "loading", binding: null });
  useEffect(() => {
    const abort = new AbortController();
    const current = () => { const latest = store.getSnapshot(); return latest.status === "authenticated" && latest.userId === userId && `${latest.userId}:${latest.identityVersion}` === scope; };
    setState({ scope, status: "loading", binding: null });
    if (enabled && userId && current()) readBankBinding(userId, abort.signal).then(value => {
      if (!abort.signal.aborted && current()) setState({ scope, status: value.integration === "INTEGRATED" ? "ready" : "unknown", binding: value.binding });
    }, error => {
      if (!abort.signal.aborted && current()) { setState({ scope, status: "unknown", binding: null }); if (error?.status === 401) session.revalidate(); }
    });
    return () => abort.abort();
  // The scope binds the identity; re-entering the overview rereads the saved card.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, userId, enabled, reload]);
  const latest = store.getSnapshot();
  return state.scope === scope && latest.status === "authenticated" && latest.userId === userId && `${latest.userId}:${latest.identityVersion}` === scope ? state : { scope, status: "loading" as const, binding: null };
}

function EntryRows({ items, bucket, onOpen }: { items: WalletEntry[]; bucket: EntryBucket; onOpen: (id: string) => void }) {
  return (
    <div className="wallet-records">
      {items.map(e => {
        const display = entryDisplayTime(e);
        const nature = entryNature(e);
        const status = entryStatus(e);
        return (
          <Link
            key={e.id}
            className={`wallet-record ${nature.reference ? "is-reference" : "is-balance"}`}
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
                "未记录"
              )}
            </span>
            <div className="wallet-record-copy">
              <div className="wallet-record-title-row">
                <strong>{financeEntryLabel(e)}</strong>
                <span className={`wallet-type-tag ${nature.reference ? "reference-tag" : "balance-tag"}`}>{nature.label}</span>
              </div>
              <small>
                {e.sourceDetails ? "单号" : bucketLabel(e.bucket)}
                {e.sourceDetails?.originalNumber ?? e.businessReference.number
                  ? ` · ${e.sourceDetails?.originalNumber ?? e.businessReference.number}`
                  : ""}
              </small>
              {e.sourceDetails?.attempts?.map(a => (
                <small key={"la_refund_log:" + a.source.id}>
                  原尝试 {a.originalNumber ?? "未记录"} · {walletMoney(a.recordedAmountCents)} ·{" "}
                  {refundAttemptStatus(a.originalStatus)}
                </small>
              ))}
            </div>
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
              {nature.note ? <small className={`wallet-delta-sub ${nature.reference ? "reference" : "balance"}`}>{nature.note}</small> : null}
            </div>
            {status ? <RecordStatus tone={e.kind === "HISTORICAL" ? "neutral" : "success"}>{status}</RecordStatus> : <span />}
            <ChevronRight size={15} aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}

function EmptyEntries({ bucket, filtered, recordsComplete, hasMore }: { bucket: EntryBucket; filtered: boolean; recordsComplete: boolean; hasMore: boolean }) {
  if (filtered) return <div className="account-empty-state"><FileText size={28} aria-hidden="true" /><h3>已加载记录中没有符合条件的流水</h3><p>可继续加载更多记录。</p></div>;
  if (bucket !== "ALL") {
    const empty = BUCKET_EMPTY[bucket];
    return <div className="account-empty-state"><FileText size={28} aria-hidden="true" /><h3>{empty.title}</h3><p>{empty.body}</p><Link className="button secondary" href={empty.href} scroll={false}>{empty.action}</Link></div>;
  }
  return <div className="account-empty-state"><FileText size={28} aria-hidden="true" /><h3>{recordsComplete && !hasMore ? "暂无流水" : "流水仍在核对"}</h3><p>{hasMore ? "可继续加载更多记录。" : recordsComplete ? "可以切换其他类型查看。" : "请稍后再来查看。"}</p></div>;
}

export function PersonalWallet({ scope }: { scope: string }) {
  const params = useSearchParams(), paneRaw = params.get("wallet"), pane = ["entries", "entry", "withdraw", "withdraw-local", "guarantees"].includes(paneRaw ?? "") ? paneRaw! : "overview", entryId = params.get("entry") ?? "", filterRaw = params.get("bucket"), bucket: EntryBucket = ['AVAILABLE','REFUND_PAYABLE','RESERVED','PENDING_EARNINGS'].includes(filterRaw??'') ? filterRaw as EntryBucket : "ALL";
  const read = useWalletRead(scope), heading = useRef<HTMLHeadingElement>(null), root = useRef<HTMLElement>(null), scopeRef = useRef(scope); scopeRef.current = scope;
  const [bankReload, setBankReload] = useState(0);
  const bankCard = useUserBankBinding(scope, pane === "overview", read.session.userId, bankReload);
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
  const refresh = () => { pageRequest.current?.abort(); detailRequest.current?.abort(); setPage({ scope, bucket, value: null, error: null, busy: true }); setDetail({ scope, id: entryId, value: null, error: null }); setBankReload(n => n + 1); read.refresh(); };
  const title = pane === "entries" ? "余额流水" : pane === "entry" ? "流水详情" : pane === "withdraw" ? "银行卡与提现" : pane === "withdraw-local" ? "提现申请" : pane === "guarantees" ? "上架保证金" : "我的钱包";
  const w = read.wallet, records = visiblePage.value;
  const recordsComplete = records?.listCoverage.knowledge === "KNOWN" && records.listCoverage.scope !== "POSTED_LEDGER_ONLY";
  const rawItems = records?.items ?? [];
  const recentItems = rawItems.filter(entry => entry.sourceKind !== "OPENING").slice(0, 5);
  const displayItems = rawItems.filter(e => {
    if (filterOnlyReal && !(e.kind === "POSTED" && e.bucket === "AVAILABLE" && e.sourceKind !== "OPENING")) return false;
    if (timeRange !== "ALL") {
      const at = entryDisplayTime(e).at;
      if (!at) return false;
      const diffDays = (Date.now() - new Date(at).getTime()) / (1000 * 3600 * 24);
      if (!Number.isFinite(diffDays) || diffDays < 0 || diffDays > (timeRange === "7D" ? 7 : 30)) return false;
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
        {/* 仅在有待处理提现申请或异常时渲染待处理横幅，平时为 null */}
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
              <p className="wallet-balance-subhint">提现条件与费用以申请时核对结果为准</p>
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
                {bankCard.status !== "ready" ? "查看资料" : bankCard.binding ? "管理卡片" : "去绑卡"}
              </Link>
            </div>
            <div className="wallet-bank-card-body">
              {bankCard.status === "loading" ? (
                <div className="bank-card-skeleton">
                  <SkeletonBlock label="正在核对收款银行卡" lines={2} />
                </div>
              ) : bankCard.status === "unknown" ? (
                <div className="bank-card-unbound-slot" role="status">收款资料暂时无法确认，请稍后查看。</div>
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
                    <span className="bank-card-network">收款银行卡</span>
                    <BankChipSvg />
                  </div>
                  <div className="bank-card-number">{bankCard.binding.cardMask}</div>
                  <div className="bank-card-bottom">
                    <div className="bank-card-holder">
                      <span className="bank-card-label">持卡人</span>
                      <span className="bank-card-name">{bankCard.binding.holderNameMask}</span>
                    </div>
                    <span className="bank-card-bound-badge">资料已保存</span>
                  </div>
                </div>
              ) : (
                <div className="bank-card-unbound-slot">
                  <div className="unbound-slot-icon" aria-hidden="true">
                    <CreditCard size={22} />
                  </div>
                  <div className="unbound-slot-copy">
                    <strong>尚未绑定收款银行卡</strong>
                    <p>保存收款资料后，还需核对提现条件。</p>
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
          {records && recentItems.length ? (
            <div className="account-module-card wallet-table-card">
              <div className="wallet-table-header" aria-hidden="true">
                <span className="th-col th-time">时间</span>
                <span className="th-col th-desc">业务类型与单号</span>
                <span className="th-col th-amount">发生金额</span>
                <span className="th-col th-status">记录状态</span>
                <span className="th-col th-action"></span>
              </div>
              <div className="wallet-table-body">
                <EntryRows items={recentItems} bucket={records.bucket} onOpen={rememberList} />
              </div>
            </div>
          ) : visiblePage.busy ? (
            <p role="status">正在读取流水…</p>
          ) : visiblePage.error ? (
            <div role="alert"><p>{errorText(visiblePage.error)}</p><button className="button secondary" onClick={() => void loadPage(null)}>重试流水</button></div>
          ) : (
            <div className="account-module-card account-empty-state"><FileText size={26} aria-hidden="true" /><h3>{recordsComplete ? "暂无余额流水" : "流水记录尚未确认"}</h3><p>{recordsComplete ? "还没有可显示的流水。" : "部分流水仍在核对，请稍后查看。"}</p></div>
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
                仅看可用余额变动
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
          {filterOnlyReal || timeRange !== "ALL" ? <p className="account-module-note">仅筛选已加载的记录；{timeRange !== "ALL" ? "时间未知的记录不在时间筛选中。" : "可继续加载更多。"}</p> : null}
          <div className="account-module-card wallet-table-card">
            <div className="wallet-table-header" aria-hidden="true">
              <span className="th-col th-time">时间</span>
              <span className="th-col th-desc">业务类型与单号</span>
              <span className="th-col th-amount">发生金额</span>
              <span className="th-col th-status">记录状态</span>
              <span className="th-col th-action"></span>
            </div>
            <div className="wallet-table-body">
              {displayItems.length ? <EntryRows items={displayItems} bucket={records.bucket} onOpen={rememberList} /> : <EmptyEntries bucket={records.bucket} filtered={filterOnlyReal || timeRange !== "ALL"} recordsComplete={recordsComplete} hasMore={Boolean(records.nextCursor)} />}
            </div>
          </div>
          <div className="wallet-records-footer">
            <p className="account-module-note">{!recordsComplete ? "已显示 " + displayItems.length + " 条，部分记录仍在核对。" : records.nextCursor || filterOnlyReal || timeRange !== "ALL" ? "已显示 " + displayItems.length + " 条" : "共 " + displayItems.length + " 条记录"}</p>
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
 const nature = entryNature(e), status = entryStatus(e);
 const note=e.sourceDetails?'旧平台记录，不影响余额。':e.kind==='HISTORICAL'?(e.includedInOpening?'已计入当前余额。':null):null;
 return <article className="account-module-card wallet-entry-detail">
   <div className="wallet-entry-detail-header">
     {status?<StatusBadge tone={e.kind === "HISTORICAL" ? "neutral" : "success"}>{status}</StatusBadge>:null}
     <span className={`wallet-type-tag ${nature.reference ? "reference-tag" : "balance-tag"}`}>{nature.label}</span>
   </div>
   <h3>{financeEntryLabel(e)}</h3>
   <strong className="wallet-main-amount">{walletMoney(e.sourceDetails?.recordedAmountCents??e.deltaCents, !e.sourceDetails)}</strong>
   {e.sourceDetails ? <p className="wallet-detail-nature-hint">这是旧平台的业务记录，金额没有计入当前余额。</p> : null}
   <dl className="account-fact-list">
     <div><dt>记录类型</dt><dd>{e.sourceDetails?'旧平台记录':bucketLabel(e.bucket)}</dd></div>
     <div><dt>{display.label}</dt><dd>{display.at?formatOrderTime(display.at, { timeZoneName: false }):'未记录'}</dd></div>
     {Object.hasOwn(e,'recordedAt')?<div><dt>记录时间</dt><dd>{e.recordedAt?formatOrderTime(e.recordedAt,{timeZoneName:false}):'未记录'}</dd></div>:null}
     {e.sourceDetails?<>{walletOriginalType(e)?<div><dt>{e.sourceKind==='HISTORICAL_WITHDRAWAL'?'原提现方式':e.sourceKind==='HISTORICAL_PAYMENT'?'原业务类型':'原退款类型'}</dt><dd>{walletOriginalType(e)}</dd></div>:null}
     <div><dt>原平台状态</dt><dd>{walletSourceStatus(e)??'未记录'}</dd></div>
     {e.sourceDetails.associationState==='UNRESOLVED'?<div><dt>关联状态</dt><dd>未记录</dd></div>:null}
     <div><dt>原记录单号</dt><dd>{e.sourceDetails.originalNumber??'未记录'}</dd></div>
     {e.sourceDetails.sourcePaidAt?<div><dt>{e.sourceKind==='HISTORICAL_DISTRIBUTION'?'原结算时间':'原支付时间'}</dt><dd>{formatOrderTime(e.sourceDetails.sourcePaidAt,{timeZoneName:false})}</dd></div>:null}
     {e.sourceDetails.attempts?.map(a=><div key={'la_refund_log:'+a.source.id}><dt>原退款尝试</dt><dd>{a.originalNumber??'未记录'} · {walletMoney(a.recordedAmountCents)} · {refundAttemptStatus(a.originalStatus)}{a.occurredAt?' · '+formatOrderTime(a.occurredAt,{timeZoneName:false}):''}</dd></div>)}
     {e.sourceDetails.reasonCodes?.length?<div><dt>原记录核对</dt><dd>这笔记录有退款需要核对。</dd></div>:null}
     <div><dt>资金含义</dt><dd>不影响余额</dd></div>
     {e.sourceDetails.originalLevel?<div><dt>原分销层级与比例</dt><dd>{e.sourceDetails.originalLevel}级 · {e.sourceDetails.originalRatio??'未记录'}</dd></div>:null}</>:null}
     <div><dt>关联单号</dt><dd>{e.businessReference.number ?? "未记录"}</dd></div>
     <div><dt>当时余额</dt><dd>{e.balanceAfterCents === null ? "未记录" : walletMoney(e.balanceAfterCents)}</dd></div>
   </dl>
   {note?<p className="account-module-note">{note}</p>:null}
 </article>;
}
