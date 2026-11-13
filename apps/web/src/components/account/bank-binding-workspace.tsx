"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { RecoveryAlert, SkeletonBlock } from "@/components/ui/information";
import {
  pendingDemoWithdrawal,
  readDemoAvailability,
  type DemoPending,
  type DemoScope,
  type DemoWithdrawalLimits,
} from "@/lib/demo-withdrawal-client";
import {
  type IdentityFailure,
  type WithdrawalPanelProps,
  asError,
  useWithdrawalIdentity,
} from "./bank-binding-types";
import { BankBindingPanel } from "./bank-binding-panel";
import { ChannelWithdrawalPanel } from "./bank-channel-withdrawal-panel";
import { DemoWithdrawalPanel } from "./bank-demo-withdrawal-panel";
import { WithdrawalHistorySection } from "./bank-withdrawal-history";
import "./bank-binding-workspace.css";

function WithdrawalPanel(props: WithdrawalPanelProps) {
  const identity = useWithdrawalIdentity(props.scope, props.onIdentityFailure);
  const [state, setState] = useState<{
    scope: string;
    mode: "loading" | "channel" | "demo" | "error";
    demoScope?: DemoScope;
    enabled?: boolean;
    limits?: DemoWithdrawalLimits;
  }>({ scope: props.scope, mode: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!identity.ready || !identity.userId) return;
    const controller = new AbortController();
    setState({ scope: props.scope, mode: "loading" });
    let original: DemoPending | null;
    try {
      original = pendingDemoWithdrawal(identity.userId);
    } catch {
      setState({ scope: props.scope, mode: "error" });
      return;
    }
    void readDemoAvailability(identity.userId, controller.signal)
      .then(value => {
        if (identity.current() && !controller.signal.aborted) {
          setState({
            scope: props.scope,
            mode: "demo",
            demoScope: value.scope,
            enabled: value.withdrawalEnabled,
            limits: value.limits,
          });
        }
      })
      .catch(error => {
        if (identity.current() && !controller.signal.aborted) {
          const e = asError(error);
          identity.identityFailure(e);
          setState({ scope: props.scope, mode: e.status === 404 && !original ? "channel" : "error" });
        }
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scope, identity.ready, identity.userId, attempt]);

  if (state.scope !== props.scope || state.mode === "loading") {
    return <section className="account-module-card"><SkeletonBlock label="正在确认提现方式" lines={2} /></section>;
  }
  if (state.mode === "error") {
    return (
      <section className="account-module-card">
        <RecoveryAlert
          tone="unknown"
          title="暂时无法确认提现方式"
          problem="如有未完成申请，请保留原浏览器状态。"
          action={<Button variant="secondary" className="bank-action" onPress={() => setAttempt(value => value + 1)}>重新读取</Button>}
        />
      </section>
    );
  }
  if (state.mode === "demo" && state.demoScope && state.limits) {
    return <DemoWithdrawalPanel {...props} demoScope={state.demoScope} enabled={state.enabled === true} limits={state.limits} />;
  }
  return <ChannelWithdrawalPanel {...props} />;
}

export function BankBindingWorkspace({
  scope,
  availableBalance = null,
  ledgerRevision = null,
  onWalletChanged,
  onIdentityFailure,
}: {
  scope: string;
  availableBalance?: string | null;
  ledgerRevision?: string | null;
  onWalletChanged: () => void;
  onIdentityFailure?: IdentityFailure;
}) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure);
  const [bindingRefresh, setBindingRefresh] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [bindingLock, setBindingLock] = useState({ scope, value: false });
  const [bound, setBound] = useState<{ scope: string; value: boolean | null }>({ scope, value: null });
  const onBoundChange = useCallback((value: boolean | null) => setBound({ scope, value }), [scope]);
  const isBankBound = bound.scope === scope ? bound.value : null;

  if (!identity.ready) {
    return identity.session.status === "guest" ? (
      <RecoveryAlert
        tone="info"
        title="登录后查看提现信息"
        problem="银行卡资料与提现记录仅本人可见。"
        action={<Link className="button primary" href="/login?next=%2Faccount%3Fview%3Dwallet%26wallet%3Dwithdraw">去登录</Link>}
      />
    ) : (
      <SkeletonBlock label="正在确认登录身份" lines={3} />
    );
  }

  return (
    <div className="bank-binding-workspace" data-testid="bank-binding-workspace" data-scope={scope}>
      <div className="bank-onboarding-stepper sr-only" aria-label="提现指引流程">
        <div className={`onboarding-step ${isBankBound === true ? "step-done" : isBankBound === false ? "step-active" : "step-waiting"}`}>
          <span className="step-badge">{isBankBound ? "✓" : "1"}</span>
          <div className="step-copy">
            <strong>{isBankBound === null ? "收款资料未记录" : isBankBound ? "收款资料已保存" : "第 1 步：保存收款资料"}</strong>
            <small>{isBankBound === true ? "银行卡归属尚未核验" : "填写收款银行卡资料"}</small>
          </div>
        </div>
        <div className={`onboarding-step ${isBankBound ? "step-active" : "step-waiting"}`}>
          <span className="step-badge">2</span>
          <div className="step-copy">
            <strong>第 2 步：金额与费用</strong>
            <small>输入提现金额并核对费用</small>
          </div>
        </div>
        <div className="onboarding-step step-waiting">
          <span className="step-badge">3</span>
          <div className="step-copy">
            <strong>第 3 步：查看处理进度</strong>
            <small>提交后可实时查询进度</small>
          </div>
        </div>
      </div>
      <div className="bank-withdrawal-grid">
        <WithdrawalPanel
          scope={scope}
          refreshKey={bindingRefresh}
          bindingLocked={bindingLock.scope === scope && bindingLock.value}
          availableBalance={availableBalance}
          ledgerRevision={ledgerRevision}
          onWalletChanged={() => {
            setHistoryRefresh(value => value + 1);
            onWalletChanged();
          }}
          onIdentityFailure={onIdentityFailure}
        />
        <BankBindingPanel
          scope={scope}
          onChanged={() => setBindingRefresh(value => value + 1)}
          onLocked={value => setBindingLock({ scope, value })}
          onIdentityFailure={onIdentityFailure}
          onBoundChange={onBoundChange}
        />
      </div>
      <WithdrawalHistorySection scope={scope} refreshKey={historyRefresh} onIdentityFailure={onIdentityFailure} />
    </div>
  );
}
