"use client";

import { AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import {
  formatOrderTime,
  orderIntentKey,
  OrderRequestError,
  runGuardedWrite,
  type GuardedError,
  type GuardedWriteResult,
  type OrderSubjectInput,
} from "@/lib/order-client";
import type { IntentKind } from "@/lib/order-intents";
import type { SettlementAmountRow } from "@/lib/order-display";
import type { PanelError, WriteOutcome } from "./order-trade-types";

export function writeError(error: unknown): string {
  if (error instanceof OrderRequestError) {
    if (error.status === 0 || error.status === 502) return "网络或网关中断，原请求结果未知；可查询原请求，不会重复执行。";
    return error.message || "操作未完成，请稍后重试。";
  }
  return "操作未完成，请稍后重试。";
}

/** The shared lib result carries structural errors; map them back to the panel outcome type. */
export function toOrderRequestError(error: GuardedError): OrderRequestError {
  return new OrderRequestError(error.status, { error: { code: error.code, message: error.message } });
}

export function mapGuardedResult<T>(result: GuardedWriteResult<T>): WriteOutcome<T> {
  if (result.status === "ok") return { status: "ok", value: result.value };
  if (result.status === "unknown") return { status: "unknown", message: writeError(toOrderRequestError(result.error)) };
  if (result.status === "unauthorized") return { status: "unauthorized", error: toOrderRequestError(result.error) };
  if (result.status === "blocked") return { status: "blocked", message: result.message };
  if (result.status === "recovery-unresolved") return { status: "recovery-unresolved", error: toOrderRequestError(result.error) };
  return { status: "definitive", error: toOrderRequestError(result.error) };
}

/**
 * Panels delegate to the same lib core as the customer-support order card, so a frozen
 * `opening.confirm` intent written by either entry is byte-compatible and recoverable by both.
 */
export async function performGuardedWrite<T>(
  subject: OrderSubjectInput | null,
  kind: IntentKind,
  resourceId: string,
  body: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  request: (key: string, body: Record<string, unknown>, context: Record<string, unknown> | undefined, subject: string) => Promise<T>,
  assertCurrent?: (subject: string) => boolean,
): Promise<WriteOutcome<T>> {
  return mapGuardedResult(await runGuardedWrite<T>({
    subject, kind, resourceId, body, context, request,
    keyFactory: orderIntentKey,
    assertCurrent,
  }));
}

export function panelError(error: unknown): PanelError {
  if (error instanceof OrderRequestError) {
    // An already-open older tab hits the new BFF without the frozen-subject header. Never relax
    // the write binding for compatibility: tell the user to reload once. The original key/body
    // stays in session storage and is recovered by the new bundle after the reload.
    if (error.status === 400 && error.code === "IDENTITY_BINDING_REQUIRED") return { message: "页面版本已更新，请刷新页面后重试；原申请已保留，不会重复提交。", retryable: false };
    if (error.status === 0) return { message: "网络中断，结果未知。原请求可安全重试，不会重复扣款或重复记账。", retryable: true };
    if (error.status === 401 || error.code === "UNAUTHENTICATED") return { message: "登录状态已变化；原申请已保留，确认身份后可恢复。", retryable: false };
    if (error.status === 403) return { message: "当前身份没有这项操作权限。", retryable: false };
    if (error.status === 404) return { message: "当前对象不存在或当前环境未开启这项交易操作。", retryable: false };
    if (error.status === 409) return { message: "服务端状态与本次请求不一致；已按最新处理状态刷新，请按最新结果操作。", retryable: false };
    if (error.status === 503) return { message: error.message || "依赖的服务端依据暂不可用。", retryable: true };
    return { message: error.message || "操作未完成，请稍后重试。", retryable: true };
  }
  return { message: "操作未完成，请稍后重试。", retryable: true };
}

export const AUTH_MESSAGE = "登录状态已变化；原申请已保留。正在确认身份，确认后可在本页恢复。";
export const BLOCKED_MESSAGE = "浏览器会话存储不可用，无法保存原请求恢复信息；已阻止提交。请启用会话存储后重试。";
export const STALE_MESSAGE = "这笔申请已超过自动查询期限。请先刷新页面并联系客服核对原申请，请勿重复提交。";

export function partyLabel(party: string): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  if (party === "SUPPORT") return "客服";
  return party;
}

export function UnknownNotice({ label, message, onQuery, onOpenOrder }: { label: string; message: string; onQuery: () => void; onOpenOrder?: () => void }) {
  return (
    <div className="order-notice is-warning" role="status">
      <AlertCircle size={17} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <span>{message}</span>
      </div>
      <div className="order-trade-actions">
        <button type="button" className="button secondary button--sm" onClick={onQuery}>
          <RefreshCw size={14} aria-hidden="true" />查询原请求结果
        </button>
        {onOpenOrder ? <button type="button" className="button quiet button--sm" onClick={onOpenOrder}>刷新订单</button> : null}
      </div>
    </div>
  );
}

export function AmountTable({ rows, caption }: { rows: SettlementAmountRow[]; caption: string }) {
  if (rows.length === 0) return null;
  return (
    <table className="order-trade-amounts" aria-label={caption}>
      <caption>{caption}</caption>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.value}{row.note ? <small>{row.note}</small> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RecordList({ title, records }: { title: string; records: Array<{ label: string; time?: string | null }> }) {
  if (records.length === 0) return null;
  return (
    <div className="order-records">
      <h3>{title}</h3>
      <ul>
        {records.map((record, index) => {
          const recordedAt = record.time;
          const knownTime = typeof recordedAt === "string" && Number.isFinite(Date.parse(recordedAt));
          return (
            <li key={`${record.label}-${index}`}>
              <span className="order-record-mark" aria-hidden="true"><CheckCircle2 size={13} /></span>
              <span>{record.label}</span>
              {knownTime ? <time dateTime={recordedAt}>{formatOrderTime(recordedAt)}</time> : <span className="order-muted">时间未记录</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 付款成功开群通知：每个浏览器会话只主动开一次 */
export function triggerOpenPaidOrderGroup(orderId: string): void {
  const key = `zzsh:order-group-autopen:${orderId}`;
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    /* sessionStorage is optional */
  }
  window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party: "renter", orderId } }));
}
