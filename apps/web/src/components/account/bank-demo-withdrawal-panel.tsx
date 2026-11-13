"use client";

/**
 * ⚠️ 调试/沙箱提现模拟面板 (DemoWithdrawalPanel)
 *
 * 关键业务隔离说明：
 * 此模块包含模拟提现目标创建、演示额度报价确认及沙箱轮询等临时逻辑，
 * 仅用于真实商户与资方通道接入前的端到端联调与 UI 行为模拟。
 * 【上线前必须彻底移除/清理此模块与相关 demo 调试逻辑】，严防测试沙箱逻辑污染生产交易链路！
 */

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { CreditCard } from "lucide-react";
import { Input } from "@/components/ui/form-controls";
import { RecoveryAlert, SkeletonBlock, StatusBadge, fieldControlProps } from "@/components/ui/information";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import { walletMoney } from "@/lib/personal-wallet-client";
import { yuanToCents } from "@/lib/controlled-withdrawal-client";
import {
  pendingBankBinding,
  readBankBinding,
  type BankBindingRead,
} from "@/lib/withdrawal-bank-binding-client";
import {
  confirmDemoWithdrawal,
  createDemoTarget,
  discardDemoTarget,
  pendingDemoWithdrawal,
  quoteDemoWithdrawal,
  readDemoIntent,
  recoverDemoWithdrawal,
  type DemoBody,
  type DemoIntent,
  type DemoPending,
  type DemoQuote,
  type DemoScope,
  type DemoWithdrawalLimits,
} from "@/lib/demo-withdrawal-client";
import {
  type WithdrawalPanelProps,
  asError,
  useWithdrawalIdentity,
} from "./bank-binding-types";

export function DemoWithdrawalPanel({
  scope,
  refreshKey,
  bindingLocked,
  availableBalance,
  ledgerRevision,
  onWalletChanged,
  onIdentityFailure,
  demoScope,
  enabled,
  limits,
}: {
  demoScope: DemoScope;
  enabled: boolean;
  limits: DemoWithdrawalLimits;
} & WithdrawalPanelProps) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure), field = useId(), generation = useRef(0), busyRef = useRef(false);
  const [binding, setBinding] = useState<BankBindingRead | null>(null), [loading, setLoading] = useState(true), [pending, setPending] = useState<DemoPending | null>(null);
  const [amount, setAmount] = useState(""), [quote, setQuote] = useState<{ body: DemoBody; quote: DemoQuote } | null>(null), [result, setResult] = useState<DemoIntent | null>(null);
  const [busy, setBusy] = useState(false), [confirmOpen, setConfirmOpen] = useState(false), [message, setMessage] = useState(""), [storageBlocked, setStorageBlocked] = useState(false);
  const sync = () => {
    try {
      const value = pendingDemoWithdrawal(identity.userId!);
      if (value && value.scope !== demoScope) throw Error();
      setPending(value);
      setStorageBlocked(false);
      return value;
    } catch {
      setStorageBlocked(true);
      return undefined;
    }
  };
  useEffect(() => {
    if (!identity.ready || !identity.userId) return;
    const controller = new AbortController(), run = ++generation.current;
    setLoading(true); setBinding(null); setQuote(null); setResult(null); setMessage("");
    const original = sync();
    if (original?.stage === "target-ready") {
      const n = BigInt(original.body.amountCents);
      setAmount(`${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`);
    } else setAmount("");
    void readBankBinding(identity.userId, controller.signal).then(value => {
      if (identity.current() && !controller.signal.aborted && run === generation.current) setBinding(value);
    }).catch(error => {
      if (identity.current() && !controller.signal.aborted && run === generation.current) {
        identity.identityFailure(asError(error));
        setMessage("收款资料暂时无法读取，请刷新重试。");
      }
    }).finally(() => {
      if (identity.current() && !controller.signal.aborted && run === generation.current) setLoading(false);
    });
    return () => { generation.current++; controller.abort(); };
    // The same identity and bank refresh define this panel's resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId, refreshKey, demoScope]);
  useEffect(() => {
    if (quote && quote.body.expectedWalletVersion !== ledgerRevision) {
      setQuote(null);
      setConfirmOpen(false);
    }
  }, [ledgerRevision, quote]);
  const run = async (action: () => Promise<void>) => {
    if (!identity.current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage("");
    try {
      await action();
    } catch (error) {
      if (identity.current()) {
        const e = asError(error);
        identity.identityFailure(e);
        const original = sync(), identityMessage: Record<string, string> = {
          DEMO_WITHDRAW_IDENTITY_REQUIRED: "请先完成本人实名认证。",
          DEMO_WITHDRAW_ADULT_REQUIRED: "确认已成年后才能提现。",
          DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED: "实名信息来源暂时无法确认，请联系客服核对。",
          DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE: `提现金额需在 ${walletMoney(limits.minCents)} 至 ${walletMoney(limits.maxCents)} 之间。`,
        };
        setMessage(
          e.status === 401
            ? "登录状态已变化，请重新进入页面。"
            : original?.stage === "target" || original?.stage === "confirm"
              ? "操作暂未确认，请先查询原申请。"
              : identityMessage[e.code] ?? "提现信息暂时无法核对，请稍后重试。"
        );
      }
    } finally {
      if (identity.current()) setBusy(false);
      busyRef.current = false;
    }
  };
  const preview = () => void run(async () => {
    if (!identity.userId || !ledgerRevision || !binding?.binding || bindingLocked || !enabled) return;
    try {
      if (pendingBankBinding(identity.userId)) {
        setMessage("请先确认收款资料的保存结果。");
        return;
      }
    } catch {
      setMessage("收款资料的保存状态无法确认，请联系客服。");
      return;
    }
    let original = sync();
    if (original === undefined || original?.stage === "target" || original?.stage === "confirm") return;
    if (!original) {
      let amountCents: string;
      try {
        amountCents = yuanToCents(amount);
        if (BigInt(amountCents) <= 0n) throw Error();
      } catch {
        setMessage("请输入大于 0、最多两位小数的金额。");
        return;
      }
      if (BigInt(amountCents) < BigInt(limits.minCents) || BigInt(amountCents) > BigInt(limits.maxCents)) {
        setMessage(`提现金额需在 ${walletMoney(limits.minCents)} 至 ${walletMoney(limits.maxCents)} 之间。`);
        return;
      }
      setResult(null);
      original = await createDemoTarget(identity.userId, demoScope, { bankBindingId: binding.binding.id, bankBindingRevision: binding.binding.revision, amountCents }, { isCurrent: identity.current });
      setPending(original);
    }
    if (original.stage !== "target-ready") return;
    try {
      const next = await quoteDemoWithdrawal(identity.userId, demoScope, original.target, ledgerRevision);
      if (identity.current()) setQuote(next);
    } catch (error) {
      if (identity.current() && asError(error).status === 409) {
        setMessage("提现条件已变化，请重新填写金额后核对。");
        return;
      }
      throw error;
    }
  });
  const recover = () => void run(async () => {
    if (!identity.userId) return;
    const recovered = await recoverDemoWithdrawal(identity.userId, demoScope, { isCurrent: identity.current });
    if (!identity.current()) return;
    setPending(recovered.pending);
    if (recovered.knowledge === "UNKNOWN") setMessage("原申请仍未确认，请稍后再次查询，或联系客服。");
    else if (recovered.intent) {
      setResult(recovered.intent);
      setQuote(null);
      onWalletChanged();
      setMessage("已找到原提现申请。");
    } else if (recovered.pending?.stage === "target-ready") {
      const n = BigInt(recovered.pending.body.amountCents);
      setAmount(`${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`);
      setMessage("已找到原收款目标，请继续核对提现信息。");
    }
  });
  const submit = () => void run(async () => {
    if (!identity.userId || !quote) return;
    try {
      if (pendingBankBinding(identity.userId)) {
        setMessage("请先确认收款资料的保存结果。");
        setConfirmOpen(false);
        return;
      }
    } catch {
      setMessage("收款资料的保存状态无法确认，请联系客服。");
      setConfirmOpen(false);
      return;
    }
    const intent = await confirmDemoWithdrawal(identity.userId, demoScope, quote.body, quote.quote, { isCurrent: identity.current });
    if (identity.current()) {
      setPending(null);
      setQuote(null);
      setConfirmOpen(false);
      setResult(intent);
      onWalletChanged();
    }
  });
  const refresh = () => void run(async () => {
    if (!identity.userId || !result) return;
    const intent = await readDemoIntent(identity.userId, demoScope, result.id);
    if (identity.current()) {
      setResult(intent);
      onWalletChanged();
    }
  });
  const resetTarget = () => void run(async () => {
    if (!identity.userId) return;
    await discardDemoTarget(identity.userId, demoScope);
    if (identity.current()) {
      setPending(null);
      setQuote(null);
      setAmount("");
    }
  });
  const readyTarget = pending?.stage === "target-ready" ? pending.target : null;
  const unknown = pending?.stage === "target" || pending?.stage === "confirm";
  const blocked = !identity.ready || loading || busy || storageBlocked || bindingLocked || !enabled || !binding?.binding || ledgerRevision === null || availableBalance === null || Boolean(unknown);
  const labels: Record<DemoIntent["state"], string> = {
    RESERVED: "金额已暂留",
    SUBMITTING: "处理中",
    PROCESSING: "处理中",
    UNKNOWN: "结果待确认",
    SUCCEEDED: "处理完成",
    FAILED: "提现未完成",
    RECONCILIATION_REQUIRED: "需要客服核对",
  };

  return <section className="account-module-card channel-withdrawal-panel" data-testid="demo-withdrawal-panel" aria-labelledby={`${field}-title`}>
    <div className="bank-section-heading"><h3 id={`${field}-title`}>银行卡提现</h3><StatusBadge tone="neutral">测试环境</StatusBadge></div>
    <p className="bank-help">测试环境不会向银行卡打款，余额会按测试记录变动。单笔范围 {walletMoney(limits.minCents)} 至 {walletMoney(limits.maxCents)}。</p>
    <div className="bank-available" aria-label="可提现余额"><span className="bank-available-caption">可提现余额</span><strong className="bank-available-sum">{walletMoney(availableBalance)}</strong></div>
    <hr className="bank-metric-divider" />
    {loading ? <SkeletonBlock label="正在读取收款资料" lines={2} /> : null}
    {!enabled ? <RecoveryAlert tone="unknown" title="提现暂不可用" problem="请稍后重试或联系客服。" /> : null}
    {!loading && binding?.integration === "INTEGRATED" && !binding.binding ? <RecoveryAlert tone="info" title="请先绑定收款银行卡" problem="保存收款资料后即可核对提现信息。" /> : null}
    {storageBlocked ? <RecoveryAlert tone="unknown" title="原申请信息暂时无法读取" problem="请保留当前浏览器状态并联系客服。" /> : unknown ? <RecoveryAlert tone="unknown" title="上次提现结果待确认" problem="请先查询原申请，确认前不能发起新的提现。" action={<Button variant="secondary" className="bank-action" isDisabled={busy} onPress={recover}>查询原申请</Button>} /> : null}
    <form className="bank-withdraw-form" onSubmit={event => { event.preventDefault(); if (quote) setConfirmOpen(true); else preview(); }} noValidate>
      <div className="bank-form-group"><label className="bank-form-label" htmlFor={`${field}-amount`}>提现金额</label><div className="bank-amount-input-box">
        <span className="bank-currency-prefix" aria-hidden="true">¥</span><Input {...fieldControlProps({ id: `${field}-amount`, helper: false })} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={blocked || Boolean(readyTarget)} className="bank-amount-input" onChange={event => { setAmount(event.target.value); setQuote(null); setMessage(""); }} />
        {!blocked && !readyTarget && availableBalance && BigInt(availableBalance) > 0n ? <Button type="button" variant="tertiary" className="bank-quick-max-btn" onPress={() => { const n = BigInt(availableBalance) > BigInt(limits.maxCents) ? BigInt(limits.maxCents) : BigInt(availableBalance); setAmount(`${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`); setQuote(null); }}>{BigInt(availableBalance) > BigInt(limits.maxCents) ? "本次最多" : "全部提现"}</Button> : null}
      </div></div>
      <div className="bank-form-group"><span className="bank-form-label">收款银行卡</span><div className="bank-destination-card" role="group" aria-label="当前收款银行卡"><div className="bank-destination-left"><CreditCard size={18} className="bank-destination-icon" aria-hidden="true" /><span className="bank-destination-name">{readyTarget ? `银行卡 •••• ${readyTarget.mask.slice(-4)}` : binding?.binding ? `银行卡 •••• ${binding.binding.cardMask.slice(-4)}` : binding?.integration === "INTEGRATED" ? "尚未绑定收款银行卡" : "收款资料暂时无法确认"}</span></div></div></div>
      {quote ? <div className="bank-fee-summary has-quote" aria-label="提现费用核算"><div className="bank-fee-row"><span>手续费</span><span>{walletMoney(quote.quote.feeCents)}</span></div><div className="bank-fee-row"><span>提现净额</span><span>{walletMoney(quote.quote.netCents)}</span></div></div> : null}
      {readyTarget ? <Button type="button" variant="tertiary" className="bank-action" isDisabled={busy} onPress={resetTarget}>重新填写金额</Button> : null}
      <div className="bank-submit-container"><Button type="submit" variant="primary" className="bank-action bank-primary bank-main-submit" isDisabled={blocked || !amount}>{busy ? "正在核对…" : quote ? "确认提现申请" : "核对提现信息"}</Button></div>
    </form>
    {message ? <p className="bank-feedback" role="status">{message}</p> : null}
    {result ? <section className="bank-result" aria-label="申请记录"><div className="bank-section-heading"><h4>申请记录</h4><StatusBadge tone="neutral">{labels[result.state]}</StatusBadge></div><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(result.amountCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(result.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(result.netCents)}</dd></div></dl><Button variant="secondary" className="bank-action" isDisabled={busy} onPress={refresh}>刷新处理进度</Button></section> : null}
    <ConfirmAlertDialog open={confirmOpen && Boolean(quote) && identity.ready} onOpenChange={setConfirmOpen} title="确认这笔提现申请？" description="测试环境不会实际打款，余额会按测试记录变动。" confirmLabel={busy ? "正在提交申请…" : "确认提交申请"} cancelLabel="返回核对" onConfirm={submit} busy={busy} confirmDisabled={blocked || !quote} className="bank-withdrawal-confirm" consequences={quote ? <dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(quote.quote.grossCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(quote.quote.feeCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(quote.quote.netCents)}</dd></div><div><dt>收款银行卡</dt><dd>{readyTarget?.mask ?? "未记录"}</dd></div></dl> : null} />
  </section>;
}
