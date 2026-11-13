"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, CreditCard, Shield, ShieldCheck } from "lucide-react";
import { maskPhone } from "@/components/auth/auth-form";
import { useUserSession } from "@/components/session/user-session-provider";
import { accountStatusLabel, identityStatusLabel, type UserIdentitySnapshot } from "@/app/user-account-status";
import { readMyCredit, CreditRequestError, type CreditOverview, type CreditGuarantee } from "@/lib/credit-guarantee-client";
import { readMyWallet, walletMoney, WalletRequestError, type WalletRead } from "@/lib/personal-wallet-client";
import { isAuthenticationFailure } from "./account-nav-constants";

export function formatGuaranteeSummary(guarantees: CreditGuarantee[]): string {
  if (guarantees.length === 0) return "按出租账号查看保证金要求";
  if (guarantees.some((g) => g.state === "REQUIRED")) return "待补号主保证金";
  if (guarantees.some((g) => g.state === "PAYMENT_PENDING")) return "保证金支付结果待确认";
  if (guarantees.some((g) => g.state === "REFUND_REQUESTED" || g.state === "REFUND_PROCESSING")) return "保证金退还处理中";
  if (guarantees.some((g) => g.state === "FAILED")) return "保证金状态待核";
  if (guarantees.some((g) => g.state === "UNKNOWN")) return "按出租账号查看保证金要求";
  if (guarantees.every((g) => g.state === "REFUNDED")) return "号主保证金退还已记录";
  if (guarantees.every((g) => g.state === "SATISFIED")) return "号主保证金已覆盖";
  if (guarantees.every((g) => g.state === "NOT_REQUIRED")) return "当前无需缴纳号主保证金";
  return "按出租账号查看保证金要求";
}

export function AccountOverviewStrip({
  scope,
  phone,
  identity,
  identityPhase,
  onRetry,
}: {
  scope: string;
  phone: string | null;
  identity: UserIdentitySnapshot | null;
  identityPhase: "loading" | "ready" | "error";
  onRetry?: () => void;
}) {
  const session = useUserSession();
  const [walletState, setWalletState] = useState<{
    scope: string;
    loading: boolean;
    wallet: WalletRead | null;
    error: WalletRequestError | null;
  }>({
    scope,
    loading: true,
    wallet: null,
    error: null,
  });
  const [creditState, setCreditState] = useState<{
    scope: string;
    loading: boolean;
    data: CreditOverview | null;
    error: string;
  }>({
    scope,
    loading: true,
    data: null,
    error: "",
  });
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setWalletState({ scope, loading: true, wallet: null, error: null });
    setCreditState({ scope, loading: true, data: null, error: "" });

    if (session.userId) {
      readMyWallet(session.userId, controller.signal).then(
        (wallet) => {
          if (current === sequence.current) setWalletState({ scope, loading: false, wallet, error: null });
        },
        (error: unknown) => {
          if (controller.signal.aborted || current !== sequence.current) return;
          const e = error instanceof WalletRequestError ? error : new WalletRequestError(0, "NETWORK_ERROR");
          if (isAuthenticationFailure(e)) session.revalidate();
          setWalletState({ scope, loading: false, wallet: null, error: e });
        }
      );
    } else {
      setWalletState({ scope, loading: false, wallet: null, error: null });
    }

    readMyCredit(controller.signal).then(
      (data) => {
        if (current === sequence.current) setCreditState({ scope, loading: false, data, error: "" });
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        if (error instanceof CreditRequestError && isAuthenticationFailure(error)) {
          session.revalidate();
        }
        const msg = error instanceof CreditRequestError && error.status === 401
          ? "登录状态已变化"
          : "信用与保证金暂时无法读取";
        setCreditState({ scope, loading: false, data: null, error: msg });
      }
    );

    return () => controller.abort();
  }, [scope, session.userId]);

  const isWalletCurrent = walletState.scope === scope;
  const isCreditCurrent = creditState.scope === scope;

  const walletDisplay = !isWalletCurrent || walletState.loading
    ? "正在读取余额"
    : walletState.wallet
    ? walletMoney(walletState.wallet.buckets.available.amountCents)
    : "钱包暂时无法读取";

  const walletNote = isWalletCurrent && walletState.wallet
    ? walletState.wallet.buckets.available.knowledge === "UNKNOWN"
      ? "可用金额尚未确认"
      : "可用余额"
    : "余额以钱包记录为准";

  const creditScore = !isCreditCurrent || creditState.loading
    ? "--"
    : typeof creditState.data?.credit?.score === "number"
    ? String(creditState.data.credit.score)
    : "--";

  const creditNote = !isCreditCurrent || creditState.loading
    ? "正在读取信用分…"
    : creditState.error
    ? creditState.error === "登录状态已变化" ? creditState.error : "请前往详情重新读取"
    : creditState.data?.creditState === "NOT_INITIALIZED"
    ? "信用档案尚未初始化"
    : formatGuaranteeSummary(creditState.data?.guarantees ?? []);

  const isVerified = identityPhase === "ready" && identity?.identityStatus === "VERIFIED";
  const hasPhone = Boolean(phone);
  const walletIsAmount = isWalletCurrent && !walletState.loading && walletState.wallet?.buckets.available.knowledge === "KNOWN";
  const creditIsLoading = !isCreditCurrent || creditState.loading;
  const score = creditState.data?.credit?.score;
  const creditIsKnown = !creditIsLoading && typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100;

  return (
    <div className="account-overview-strip">
      <div className="overview-strip-col wallet-col account-wallet-preview">
        <div className="strip-col-icon" aria-hidden="true"><CreditCard size={22} /></div>
        <div className="strip-col-main">
          <div className="strip-col-header">
            <h3>我的钱包</h3>
          </div>
          <div className="strip-col-body">
            <strong className={`strip-col-value${walletIsAmount ? "" : " is-status"}`} data-testid="wallet-summary-amount">{walletDisplay}</strong>
            <p className="strip-col-note">{walletNote}</p>
          </div>
          <Link className="strip-col-link" href="/account?view=wallet" scroll={false}>
            <span>查看钱包</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="overview-strip-col credit-col account-credit-preview">
        <div className="strip-col-icon" aria-hidden="true"><ShieldCheck size={22} /></div>
        <div className="strip-col-main">
          <div className="strip-col-header">
            <h3>信用与号主保证金</h3>
          </div>
          <div className="strip-col-body">
            {creditIsKnown ? (
              <div className="credit-gauge" data-state={score === 100 ? "full" : "known"} role="meter" aria-label="信用分" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-valuetext={`${creditScore}分，满分100分`}>
                <svg viewBox="0 0 148 82" aria-hidden="true">
                  <path className="credit-gauge-track" d="M14 66 A60 60 0 0 1 134 66" pathLength="100" />
                  <path className="credit-gauge-fill" d="M14 66 A60 60 0 0 1 134 66" pathLength="100" strokeDasharray={`${score} 100`} />
                  <text x="14" y="80">0</text><text x="134" y="80">100</text>
                </svg>
                <strong className="strip-credit-number">{creditScore}<small>分</small></strong>
              </div>
            ) : (
              <p className="strip-value-status" role="status">
                <span className="account-status-dot" aria-hidden="true" />
                {creditIsLoading ? "正在读取信用分…" : creditState.error ? "暂时无法读取" : "信用分待确认"}
              </p>
            )}
            <p className="strip-col-note">{creditNote}</p>
          </div>
          <Link className="strip-col-link" href="/account?view=credit" scroll={false}>
            <span>查看详情</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="overview-strip-col security-col account-status-panel">
        <div className="strip-col-icon" aria-hidden="true"><Shield size={22} /></div>
        <div className="strip-col-main">
          <div className="strip-col-header">
            <h3>实名与安全</h3>
          </div>
          <div className="strip-col-body">
          {identityPhase === "error" ? (
            <div className="account-status-retry" role="alert">
              <span>账号状态暂无法读取</span>
              {onRetry ? (
                <button type="button" className="button secondary button--xs" onClick={onRetry}>
                  重试
                </button>
              ) : null}
            </div>
          ) : identityPhase === "loading" ? (
            <div className="strip-security-status-row" role="status">
              <span className="strip-status-pill is-loading">正在读取账号状态…</span>
            </div>
          ) : (
            <div className="strip-security-status-row">
              {identity && identity.accountStatus !== "ACTIVE" ? (
                <>
                  <span className="strip-status-pill is-attention">
                    {accountStatusLabel(identity.accountStatus)}
                  </span>
                </>
              ) : null}
              <span className={`strip-status-pill ${isVerified ? "is-ok" : "is-attention"}`}>
                {identity ? identityStatusLabel(identity.identityStatus) : "尚未验证"}
              </span>
              <span className={`strip-status-pill ${hasPhone ? "is-ok" : "is-attention"}`}>
                {hasPhone ? "手机已绑定" : "未绑定手机"}
              </span>
            </div>
          )}
          <p className="strip-col-note">
            {identityPhase === "loading"
              ? "正在读取手机绑定信息…"
              : phone
              ? `绑定手机 ${maskPhone(phone)}`
              : identityPhase === "error" ? "信息尚未确认，请重新读取" : "绑定手机可提高账号安全等级"}
          </p>
          {identityPhase === "ready" && identity?.provider === "fake" ? (
            <p className="account-status-note">实名状态来自本地测试环境</p>
          ) : null}
          </div>
          <Link className="strip-col-link" href="/account?view=security" scroll={false}>
            <span>查看账号安全</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}
