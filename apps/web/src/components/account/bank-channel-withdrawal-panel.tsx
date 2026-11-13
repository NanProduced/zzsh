"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { ChevronDown, CreditCard, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/form-controls";
import { RecoveryAlert, SkeletonBlock, StatusBadge, fieldControlProps } from "@/components/ui/information";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import { walletMoney } from "@/lib/personal-wallet-client";
import { yuanToCents } from "@/lib/controlled-withdrawal-client";
import { WithdrawalRequestError } from "@/lib/withdrawal-client-core";
import { pendingBankBinding } from "@/lib/withdrawal-bank-binding-client";
import {
  pendingChannelWithdrawal,
  quoteChannelWithdrawal,
  readChannelWithdrawal,
  readChannelWithdrawalOptions,
  recoverChannelWithdrawal,
  submitChannelWithdrawal,
  type ChannelWithdrawalIntent,
  type ChannelWithdrawalQuote,
  type PendingChannelWithdrawal,
  type WithdrawalOptions,
} from "@/lib/channel-withdrawal-client";
import {
  recoverWithdrawalFromHistory,
  type WithdrawalHistoryRecovery,
} from "@/lib/withdrawal-history-client";
import {
  type IdentityFailure,
  type ReadState,
  asError,
  timeLabel,
  errorCopy,
  ErrorDetails,
  channelStateLabel,
  useWithdrawalIdentity,
} from "./bank-binding-types";

const reasonLabel: Record<string, string> = {
  WITHDRAWAL_CHANNEL_NOT_CONFIGURED: "提现暂不可用，仍可查看收款资料和记录",
  WITHDRAWAL_REQUESTS_NOT_CONFIGURED: "当前仅支持查看已有记录，尚未开放新的提现申请",
  BANK_BINDING_REQUIRED: "请先绑定收款银行卡",
  BANK_BINDING_NOT_INTEGRATED: "暂时无法查看收款资料",
  BANK_BINDING_UNAVAILABLE: "收款资料暂时无法核对",
  IDENTITY_NOT_VERIFIED: "身份资料尚未满足提现要求",
  REAL_IDENTITY_REQUIRED: "身份资料尚未满足提现要求",
  REAL_IDENTITY_SOURCE_REQUIRED: "实名信息未记录",
  IDENTITY_PROVIDER_MISMATCH: "实名信息未记录",
  ADULT_STATUS_REQUIRED: "当前年龄资料不符合提现要求",
  USER_NOT_ADULT: "当前年龄资料不符合提现要求",
  IDENTITY_EXPIRED: "实名信息需要更新",
  IDENTITY_PROOF_EXPIRED_OR_INVALID: "实名信息已过期或无效，请重新认证",
  NEW_REQUESTS_DISABLED: "当前暂未开放新的提现申请",
  POLICY_UNAVAILABLE: "提现规则暂时无法读取",
  WITHDRAWAL_POLICY_UNAVAILABLE: "提现规则暂时无法读取",
  WITHDRAWAL_QUOTA_UNKNOWN: "今日提现次数暂时无法确认",
  WITHDRAWAL_QUOTA_EXHAUSTED: "今日提现申请次数已用完",
};

/** Only describe what the server returned; unknown values stay unknown instead of becoming eligibility. */
function identityStatusLabel(value: string | undefined): string {
  return value === "VERIFIED" ? "已实名" : value === "UNVERIFIED" ? "未实名" : value === "REJECTED" ? "实名未通过" : "实名状态未记录";
}

function ageStatusLabel(value: string | undefined): string {
  return value === "ADULT" ? "已成年" : value === "MINOR" ? "未成年" : "年龄状态未记录";
}

export function IntentFacts({ intent, onRefresh, busy }: { intent: ChannelWithdrawalIntent; onRefresh: () => void; busy: boolean }) {
  return <section className="bank-result" aria-label="原提现申请记录">
    <div className="bank-section-heading"><h4>申请记录</h4><StatusBadge tone={intent.requiresReview ? "unknown" : "neutral"}>{channelStateLabel[intent.state] ?? "状态未确认"}</StatusBadge></div>
    <dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(intent.amountCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(intent.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(intent.netCents)}</dd></div><div><dt>原收款银行卡</dt><dd>{intent.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>申请时间</dt><dd>{timeLabel(intent.acceptedAt)}</dd></div><div><dt>申请单号</dt><dd>{intent.merchantOrderNo}</dd></div><div><dt>到账情况</dt><dd>未记录</dd></div></dl>
    <p className="bank-help">手续费由你承担，到账情况请以收款记录为准。更换银行卡不会改变本次收款账户。</p>
    <Button variant="secondary" className="bank-action" isDisabled={busy} onPress={onRefresh}>刷新申请记录</Button>
  </section>;
}

export function ChannelWithdrawalPanel({ scope, refreshKey, bindingLocked, availableBalance, onWalletChanged, onIdentityFailure }: {
  scope: string; refreshKey: number; bindingLocked: boolean; availableBalance: string | null; onWalletChanged: () => void; onIdentityFailure?: IdentityFailure;
}) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure), id = useId();
  const [read, setRead] = useState<ReadState<WithdrawalOptions>>({ scope, value: null, busy: true, error: null });
  const [amount, setAmount] = useState({ scope, value: "" }), [quote, setQuote] = useState<{ scope: string; value: ChannelWithdrawalQuote } | null>(null);
  const [pendingValue, setPending] = useState<PendingChannelWithdrawal | null>(null), [storageBlockedValue, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false), [confirmOpen, setConfirmOpen] = useState(false), [noticeValue, setNotice] = useState("");
  const [errorValue, setError] = useState<WithdrawalRequestError | null>(null), [result, setResult] = useState<{ scope: string; value: ChannelWithdrawalIntent } | null>(null);
  const [knownIntent, setKnownIntent] = useState<{ scope: string; id: string } | null>(null);
  const [localRecovery, setLocalRecovery] = useState<{ scope: string; value: WithdrawalHistoryRecovery } | null>(null);
  const request = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null), generation = useRef(0), busyRef = useRef(false), quoteBusyRef = useRef(false), changedRef = useRef(onWalletChanged);
  changedRef.current = onWalletChanged;
  const options = read.scope === scope && identity.ready ? read.value : null;
  const pending = read.scope === scope && identity.ready ? pendingValue : null;
  const storageBlocked = read.scope === scope && identity.ready && storageBlockedValue;
  const notice = read.scope === scope && identity.ready ? noticeValue : "";
  const error = read.scope === scope && identity.ready ? errorValue : null;
  const visibleQuote = quote?.scope === scope && identity.ready ? quote.value : null;
  const visibleResult = result?.scope === scope && identity.ready ? result.value : null;
  const amountText = amount.scope === scope && identity.ready ? amount.value : "";
  const syncPending = () => {
    if (!identity.current() || !identity.userId) return null;
    try { const p = pendingChannelWithdrawal(identity.userId); setPending(p); setStorageBlocked(false); return p; }
    catch { setStorageBlocked(true); return undefined; }
  };
  const load = async () => {
    if (!identity.current()) return;
    if (quoteBusyRef.current) { quoteBusyRef.current = false; busyRef.current = false; setBusy(false); }
    request.current?.abort(); const abort = new AbortController(), ticket = ++generation.current; request.current = abort;
    setRead({ scope, value: null, busy: true, error: null }); setQuote(null); setConfirmOpen(false); syncPending();
    try { const value = await readChannelWithdrawalOptions(identity.userId!, abort.signal); if (identity.current() && !abort.signal.aborted && ticket === generation.current) setRead({ scope, value, busy: false, error: null }); }
    catch (e) { if (identity.current() && !abort.signal.aborted && ticket === generation.current) { const failure = asError(e); setRead({ scope, value: null, busy: false, error: failure }); identity.identityFailure(failure); } }
  };
  useEffect(() => {
    setAmount({ scope, value: "" }); setQuote(null); setConfirmOpen(false); setPending(null); setResult(null); setKnownIntent(null); setLocalRecovery(null); setNotice(""); setError(null); setStorageBlocked(false); setBusy(false); busyRef.current = false; quoteBusyRef.current = false;
    if (identity.ready) void load();
    return () => { generation.current++; request.current?.abort(); write.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId]);
  const priorBindingRefresh = useRef(refreshKey);
  useEffect(() => {
    if (priorBindingRefresh.current === refreshKey) return;
    priorBindingRefresh.current = refreshKey;
    if (identity.ready) void load();
    // Updating the current bank invalidates a draft quote, never the original submitted record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const blocked = !identity.ready || !options?.canQuote || !options.policy || !options.bankBinding.binding || bindingLocked || Boolean(pending) || storageBlocked;

  const preview = async (event?: FormEvent) => {
    if (event) event.preventDefault();
    if (!identity.current() || !identity.userId || blocked || busyRef.current || !options?.policy || !options.bankBinding.binding) return;
    if (syncPending() !== null) return;
    try { if (pendingBankBinding(identity.userId)) { setNotice("请先确认收款资料的上次保存结果，再核对提现费用。"); return; } }
    catch { setStorageBlocked(true); return; }
    let cents: string;
    try { cents = yuanToCents(amountText); if (BigInt(cents) <= 0n) throw new Error(); }
    catch { setNotice("请输入大于0、最多两位小数的提现金额。"); return; }
    busyRef.current = true; quoteBusyRef.current = true; setBusy(true); setError(null); setNotice(""); setQuote(null);
    const abort = new AbortController(), ticket = ++generation.current; request.current?.abort(); request.current = abort;
    try {
      const next = await quoteChannelWithdrawal(identity.userId, { amountCents: cents, destinationId: options.bankBinding.binding.id, policyVersion: options.policy.version }, abort.signal);
      if (identity.current() && !abort.signal.aborted && ticket === generation.current) {
        if (next.destination.revision !== options.bankBinding.binding.revision) {
          busyRef.current = false; setBusy(false); setNotice("收款资料已有更新，请重新读取后核对。"); void load();
        } else {
          setQuote({ scope, value: next });
        }
      }
    }
    catch (e) { if (identity.current() && !abort.signal.aborted && ticket === generation.current) { const failure = asError(e); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current() && ticket === generation.current) { busyRef.current = false; quoteBusyRef.current = false; setBusy(false); } }
  };
  const submit = async () => {
    if (!identity.current() || !identity.userId || !visibleQuote || blocked || busyRef.current) return;
    if (syncPending() !== null) { setConfirmOpen(false); return; }
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    const abort = new AbortController(); write.current = abort;
    try { const intent = await submitChannelWithdrawal(identity.userId, visibleQuote, { isCurrent: identity.current, signal: abort.signal }); if (identity.current()) { setResult({ scope, value: intent }); setKnownIntent({ scope, id: intent.id }); setQuote(null); setConfirmOpen(false); setAmount({ scope, value: "" }); setNotice("申请已记录，处理及到账情况请以原申请记录为准。"); changedRef.current(); } }
    catch (e) { if (identity.current()) { const failure = asError(e); setError(failure); setConfirmOpen(false); setQuote(null); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); syncPending(); } }
  };
  const recover = async () => {
    if (!identity.current() || !identity.userId || busyRef.current || storageBlocked || !syncPending()) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(""); setLocalRecovery(null);
    const abort = new AbortController(); write.current = abort;
    try { const reply = await recoverChannelWithdrawal(identity.userId, { isCurrent: identity.current, signal: abort.signal }); if (identity.current()) { if (reply.knowledge === "KNOWN" && reply.receipt) { setKnownIntent({ scope, id: reply.receipt.id }); setResult(reply.current ? { scope, value: reply.current } : null); setAmount({ scope, value: "" }); setNotice(reply.current ? "申请已确认，到账情况仍未记录。" : "申请已确认，请刷新查看最新进度。"); changedRef.current(); } else setNotice("暂未确认申请结果，请稍后继续查询。"); } }
    catch (e) { if (identity.current()) { const failure = asError(e); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); syncPending(); } }
  };
  const readLocalRecovery = async () => {
    if (!identity.current() || !identity.userId || busyRef.current || storageBlocked) return;
    const original = syncPending(); if (!original) return;
    busyRef.current = true; setBusy(true); setError(null);
    const abort = new AbortController(); write.current = abort;
    try { const value = await recoverWithdrawalFromHistory(identity.userId, original.key, abort.signal); if (identity.current()) setLocalRecovery({ scope, value }); }
    catch (e) { if (identity.current()) { const failure = asError(e); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); } }
  };
  const refreshIntent = async () => {
    if (!identity.current() || !identity.userId || knownIntent?.scope !== scope || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    const abort = new AbortController(); write.current = abort;
    try { const value = await readChannelWithdrawal(identity.userId, knownIntent.id, abort.signal); if (identity.current()) setResult({ scope, value }); }
    catch (e) { if (identity.current()) { const failure = asError(e); setResult(null); setError(failure); identity.identityFailure(failure); } }
    finally { if (identity.current()) { busyRef.current = false; setBusy(false); } }
  };
  const canEditAmount = identity.ready && !busy && !pending && !storageBlocked;

  return <section className="account-module-card channel-withdrawal-panel" data-testid="channel-withdrawal-panel" aria-labelledby={`${id}-title`}>
    <div className="bank-section-heading">
      <h3 id={`${id}-title`} className="sr-only">银行卡提现</h3>
      <Button variant="tertiary" className="bank-action bank-refresh-corner" isDisabled={read.busy || busy} onPress={() => void load()} aria-label="刷新提现资料">
        <RefreshCw size={15} className={read.busy ? "animate-spin" : ""} aria-hidden="true" />
        刷新
      </Button>
    </div>

    {/* Hero 区域：可提现余额（对齐图 2） */}
    <div className="bank-available" aria-label="可提现余额">
      <span className="bank-available-caption">可提现余额</span>
      <strong className="bank-available-sum">{walletMoney(availableBalance)}</strong>
    </div>

    <hr className="bank-metric-divider" />

    {storageBlocked ? <RecoveryAlert tone="unknown" title="原申请信息暂时无法读取" problem="无法确认是否已有提交，已暂停新申请。请保留当前浏览器状态。" /> : pending ? <RecoveryAlert tone="unknown" title="上次提现结果未记录" problem="请先查询处理结果，确认前无法再次申请。" action={<div className="bank-actions"><Button variant="primary" className="bank-action bank-primary" isDisabled={busy} onPress={() => void recover()}>{busy ? "正在查询…" : "查询提现进度"}</Button><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={() => void readLocalRecovery()}>查看申请记录</Button></div>} /> : null}
    {read.busy ? <SkeletonBlock label="正在确认提现条件" lines={2} /> : read.error ? <RecoveryAlert tone="error" title="暂时无法确认提现条件" problem={errorCopy(read.error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={read.error} /> }} /> : options && !options.canQuote ? <>
      {options.bankBinding.integration === "INTEGRATED" && !options.bankBinding.binding ? <div className="bank-onboarding-callout" role="note"><p><strong>请先保存收款银行卡</strong></p><small>保存后仍需核对其他提现条件与费用。</small></div> : null}
      <RecoveryAlert tone="unknown" title="当前暂不可申请提现" problem={[...new Set(options.reasonCodes.map(code => reasonLabel[code] ?? "暂不满足提现条件"))].join("；") || "当前提现条件尚未确认。"} />
    </> : null}

    {options?.policy ? <div className="bank-policy"><span>单笔 {walletMoney(options.policy.minCents)}–{walletMoney(options.policy.maxCents)}</span><span>{options.policy.fee.kind === "FIXED" ? `手续费 ${walletMoney(options.policy.fee.cents)}` : "手续费按比例计算，输入金额后自动核算"}</span><span>每个时段最多 {options.policy.maxIntents} 笔</span></div> : null}

    {/* 表单核心区域：对齐图 2 结构 */}
    <form className="bank-withdraw-form" onSubmit={e => {
      e.preventDefault();
      if (visibleQuote) {
        setConfirmOpen(true);
      } else {
        void preview(e);
      }
    }} noValidate>
      <div className="bank-form-group">
        <label className="bank-form-label" htmlFor={`${id}-amount`}>提现金额</label>
        <div className="bank-amount-input-box">
          <span className="bank-currency-prefix" aria-hidden="true">¥</span>
          <Input
            {...fieldControlProps({ id: `${id}-amount`, helper: false })}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountText}
            disabled={!canEditAmount}
            className="bank-amount-input"
            onChange={e => {
              setAmount({ scope, value: e.target.value });
              setQuote(null);
              setConfirmOpen(false);
              setNotice("");
            }}
          />
          {canEditAmount && availableBalance && BigInt(availableBalance) > 0n ? (
            <Button
              type="button"
              variant="tertiary"
              className="bank-quick-max-btn"
              onPress={() => {
                const cents = BigInt(availableBalance);
                const yuan = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
                setAmount({ scope, value: yuan });
                setQuote(null);
                setConfirmOpen(false);
                setNotice("");
              }}
            >
              全部提现
            </Button>
          ) : null}
        </div>
      </div>

      {/* 收款银行卡行（对齐图 2） */}
      <div className="bank-form-group">
        <span className="bank-form-label">收款银行卡</span>
        <div className="bank-destination-card" role="group" aria-label="当前收款银行卡">
          <div className="bank-destination-left">
            <CreditCard size={18} className="bank-destination-icon" aria-hidden="true" />
            <span className="bank-destination-name">
              {options?.bankBinding?.binding
                ? `银行卡 •••• ${options.bankBinding.binding.cardMask.slice(-4)}`
                : options?.bankBinding?.integration === "INTEGRATED"
                  ? "尚未绑定收款银行卡"
                  : "收款资料未记录"}
            </span>
          </div>
          <ChevronDown size={16} className="bank-destination-chevron" aria-hidden="true" />
        </div>
      </div>

      {/* 手续费与实际到账明细（对齐图 2） */}
      {visibleQuote && !blocked ? (
        <div className="bank-quote bank-fee-summary has-quote" aria-label="提现费用核算">
          <div className="bank-fee-row">
            <span className="bank-fee-name">手续费</span>
            <span className="bank-fee-val">{walletMoney(visibleQuote.feeCents)}</span>
          </div>
          <div className="bank-fee-row">
            <span className="bank-fee-name">实际到账</span>
            <span className="bank-fee-val is-highlight">{walletMoney(visibleQuote.netCents)}</span>
          </div>
          <div className="bank-fee-row bank-quote-destination">
            <span className="bank-fee-name">收款卡号</span>
            <span className="bank-fee-val">{visibleQuote.destination.mask}</span>
          </div>
          <p className="bank-help bank-quote-note">手续费由你承担。确认前不会扣款，到账情况以收款记录为准。</p>
        </div>
      ) : (
        <div className="bank-fee-summary" aria-label="提现费用核算">
          <div className="bank-fee-row">
            <span className="bank-fee-name">手续费</span>
            <span className="bank-fee-val">以确认时为准</span>
          </div>
          <div className="bank-fee-row">
            <span className="bank-fee-name">实际到账</span>
            <span className="bank-fee-val">以确认时为准</span>
          </div>
        </div>
      )}

      {bindingLocked ? <p className="bank-help">请先确认收款资料的保存结果，再核对提现费用。</p> : null}
      {error ? <RecoveryAlert tone={pending ? "unknown" : "error"} live title={pending ? "申请结果尚未确认" : "本次操作未完成"} problem={errorCopy(error)} details={{ summary: "查看查询信息", body: <ErrorDetails error={error} /> }} /> : null}

      {/* 底部右侧主操作按钮（对齐图 2） */}
      <div className="bank-submit-container">
        <Button
          type="submit"
          variant="primary"
          className="bank-action bank-primary bank-main-submit"
          isDisabled={blocked || busy || !amountText}
          onPress={() => {
            if (visibleQuote) {
              setConfirmOpen(true);
            }
          }}
        >
          {busy ? "正在核对…" : visibleQuote ? "确认提现申请" : "核对提现信息"}
        </Button>
      </div>
    </form>

    {options ? <details className="bank-eligibility" aria-label="提现资格与次数"><summary>查看提现条件</summary><dl className="bank-facts">
      <div><dt>实名状态</dt><dd>{identityStatusLabel(options.identity?.identityStatus)}</dd></div>
      <div><dt>年龄状态</dt><dd>{ageStatusLabel(options.identity?.ageStatus)}</dd></div>
      {options.identity?.verifiedAt ? <div><dt>实名核验时间</dt><dd>{timeLabel(options.identity.verifiedAt)}</dd></div> : null}
      {options.quota ? <><div><dt>已申请</dt><dd>{options.quota.used} / {options.quota.maxIntents} 笔</dd></div><div><dt>剩余次数</dt><dd>{options.quota.remaining} 笔</dd></div><div><dt>有效时间</dt><dd>{timeLabel(options.quota.windowStart)} 至 {timeLabel(options.quota.windowEnd)}</dd></div></> : null}
    </dl>{!options.identity ? <p className="bank-help">实名信息未记录。</p> : null}{!options.quota ? <p className="bank-help">提现次数未记录。</p> : null}</details> : null}

    {notice ? <p className="bank-feedback" role="status">{notice}</p> : null}
    {pending && localRecovery?.scope === scope ? <section className="bank-result" aria-label="申请记录"><h4>申请记录</h4>{localRecovery.value.knowledge === "KNOWN" && localRecovery.value.item ? <><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(localRecovery.value.item.amountCents)}</dd></div><div><dt>原收款银行卡</dt><dd>{localRecovery.value.item.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>处理状态</dt><dd>{channelStateLabel[localRecovery.value.item.state] ?? "状态未确认"}</dd></div></dl><p className="bank-help">已找到申请记录，但上次提交结果仍未记录。请勿重复申请。</p></> : <p className="bank-help">暂未找到可确认的申请记录，请稍后再查，勿重复申请。</p>}</section> : null}
    {visibleResult ? <IntentFacts intent={visibleResult} onRefresh={() => void refreshIntent()} busy={busy} /> : knownIntent?.scope === scope ? <Button variant="secondary" className="bank-action" isDisabled={busy} onPress={() => void refreshIntent()}>刷新申请进度</Button> : null}
    <ConfirmAlertDialog open={confirmOpen && Boolean(visibleQuote) && identity.ready} onOpenChange={setConfirmOpen} title="确认这笔提现申请？" description="申请受理后，提现金额将暂留；到账情况以收款记录为准。" confirmLabel={busy ? "正在提交申请…" : "确认提交申请"} cancelLabel="返回核对" onConfirm={() => void submit()} busy={busy} confirmDisabled={blocked || !visibleQuote} className="bank-withdrawal-confirm" consequences={visibleQuote ? <dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(visibleQuote.grossCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(visibleQuote.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(visibleQuote.netCents)}</dd></div><div><dt>收款银行卡</dt><dd>{visibleQuote.destination.mask}</dd></div></dl> : null} />
  </section>;
}
