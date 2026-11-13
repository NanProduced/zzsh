"use client";

import * as React from "react";
import { useCallback, useEffect, useRef } from "react";
import { formatOrderTime } from "@/lib/order-client";
import { WithdrawalRequestError } from "@/lib/withdrawal-client-core";
import type { PendingBankBinding } from "@/lib/withdrawal-bank-binding-client";
import { useUserSession, useUserSessionStore } from "@/components/session/user-session-provider";

export type IdentityFailure = (error: WithdrawalRequestError) => void;
export type ReadState<T> = { scope: string; value: T | null; busy: boolean; error: WithdrawalRequestError | null };
export type BankFormContext = { kind: "new" } | { kind: "recovery"; expectedPending: PendingBankBinding };
export type BankDraft = { scope: string; open: boolean; name: string; cardNo: string; error: string; context: BankFormContext | null };
export type WithdrawalPanelProps = {
  scope: string;
  refreshKey: number;
  bindingLocked: boolean;
  availableBalance: string | null;
  ledgerRevision: string | null;
  onWalletChanged: () => void;
  onIdentityFailure?: IdentityFailure;
};

export const emptyBankDraft = (scope: string): BankDraft => ({
  scope,
  open: false,
  name: "",
  cardNo: "",
  error: "",
  context: null,
});

export const sameBankPending = (a: PendingBankBinding | null | undefined, b: PendingBankBinding) =>
  Boolean(a && a.userId === b.userId && a.key === b.key && a.expectedRevision === b.expectedRevision);

export const asError = (error: unknown) =>
  error instanceof WithdrawalRequestError ? error : new WithdrawalRequestError(0, "NETWORK_ERROR");

export const timeLabel = (value: string | null | undefined) =>
  value ? formatOrderTime(value, { timeZoneName: false }) : "时间未提供";

export function errorCopy(error: WithdrawalRequestError | null) {
  if (!error) return "暂时无法读取，请稍后重试。";
  if (error.code === "RECOVERY_STORAGE_UNAVAILABLE") return "暂时无法确认上次操作，请保留当前页面并联系客服。";
  if (error.code === "PENDING_REQUEST_EXISTS") return "上次申请的结果未记录，请先查看进度。";
  if (error.code === "WRITE_LOCK_UNAVAILABLE") return "当前浏览器无法保护重复提交，请更换受支持的浏览器后重试。";
  if (error.status === 401) return "登录身份已变化，请重新确认登录后继续。";
  if (error.status === 403) return "当前账号暂不能进行此操作，已有记录仍可单独查询。";
  if (error.status === 409) return "资料或费用已变化，请刷新后核对；上次申请仍需先确认结果。";
  if (error.status === 400) return "填写的信息不符合要求，请核对后重试。";
  if (error.status === 503 || error.status === 502 || error.code === "EVIDENCE_UNAVAILABLE") return "服务暂时无法读取，请稍后重试。";
  return "本次未能确认处理结果，请稍后重新查询。";
}

export function ErrorDetails({ error }: { error: WithdrawalRequestError }) {
  return React.createElement(
    "span",
    null,
    error.requestId ? `查询编号：${error.requestId}` : "请稍后重试，或联系客服。"
  );
}

export const channelStateLabel: Record<string, string> = {
  RESERVED: "金额已暂留",
  SUBMITTING: "提交中",
  PROCESSING: "处理中",
  UNKNOWN: "结果未记录",
  CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "到账未记录",
  SUCCEEDED: "到账未记录",
  FAILED: "处理结果未记录",
  RECONCILIATION_REQUIRED: "需要人工核对",
};

export function useWithdrawalIdentity(scope: string, onIdentityFailure?: IdentityFailure) {
  const session = useUserSession(), store = useUserSessionStore();
  const userId = session.userId;
  const mounted = useRef(false), liveScope = useRef(scope), failureRef = useRef(onIdentityFailure);
  liveScope.current = scope;
  failureRef.current = onIdentityFailure;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => {
    const latest = store.getSnapshot();
    return mounted.current && Boolean(userId) && latest.status === "authenticated" && latest.userId === userId
      && liveScope.current === scope && `${latest.userId}:${latest.identityVersion}` === scope;
  }, [scope, store, userId]);
  const identityFailure = (error: WithdrawalRequestError) => {
    if (error.status === 401) {
      if (failureRef.current) failureRef.current(error);
      else session.revalidate();
    }
  };
  const ready = session.status === "authenticated" && Boolean(userId) && `${userId}:${session.identityVersion}` === scope;
  return { userId, current, ready, session, identityFailure };
}
