/**
 * Shared original-request contract for order writes.
 *
 * Both the order detail panels and the customer-support order card use this core. A write that
 * may have reached the server is never re-created with a new key or a new body: the frozen
 * subject/action/key/body/context is persisted per user before the request, kept when the result
 * is unknown, and only cleared after a definitive outcome. Another identity can never see or
 * reuse the original bytes, and a later session value is never used to re-derive the subject.
 *
 * This module is deliberately free of React and of `order-client` so the HTTP client can call it
 * without a dependency cycle. Errors are structural; each caller maps them to its own type.
 */
import { inspectIntent, saveIntent, clearIntent, type IntentKind } from "./order-intents.ts";
import { orderSubjectUserId, type OrderSubject } from "./order-subject.ts";

export type GuardedError = { status: number; code: string; message: string };

export type GuardedWriteResult<T> =
  | { status: "ok"; value: T }
  | { status: "unknown"; error: GuardedError }
  | { status: "unauthorized"; error: GuardedError }
  | { status: "blocked"; message: string }
  | { status: "recovery-unresolved"; error: GuardedError }
  | { status: "definitive"; error: GuardedError };

export function guardedErrorOf(error: unknown): GuardedError {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
    const status = typeof candidate.status === "number" ? candidate.status : 0;
    return {
      status,
      code: typeof candidate.code === "string" ? candidate.code : status === 0 ? "NETWORK_ERROR" : "INTERNAL_ERROR",
      message: typeof candidate.message === "string" ? candidate.message : "订单请求未完成，请稍后重试",
    };
  }
  return { status: 0, code: "NETWORK_ERROR", message: "订单请求未完成，请稍后重试" };
}

export type GuardedWriteRequest<T> = (
  key: string,
  body: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  subject: string,
) => Promise<T>;

export async function runGuardedWrite<T>(options: {
  /** Frozen subject captured when the operation was created or recovered. */
  subject: OrderSubject | string | null | undefined;
  kind: IntentKind;
  resourceId: string;
  body: Record<string, unknown>;
  context?: Record<string, unknown>;
  request: GuardedWriteRequest<T>;
  keyFactory: () => string;
  assertCurrent?: (subject: string) => boolean;
  /** Refuse a brand-new write while an unresolved original request exists, instead of replaying it. */
  refuseExisting?: boolean;
  pendingCode?: string;
  pendingMessage?: string;
}): Promise<GuardedWriteResult<T>> {
  const userId = orderSubjectUserId(options.subject);
  if (!userId) return { status: "definitive", error: { status: 401, code: "ORDER_SUBJECT_NOT_FROZEN", message: "订单请求缺少已冻结的操作主体；原申请已保留。" } };
  if (options.assertCurrent && !options.assertCurrent(userId)) {
    // Do not save a new intent, do not generate a new key, do not send.
    return { status: "unauthorized", error: { status: 401, code: "ORDER_SUBJECT_CHANGED", message: "登录身份已变化；原申请已保留，请刷新后按原请求核对。" } };
  }
  const inspected = inspectIntent(userId, options.kind, options.resourceId);
  // Unreadable original bytes still own a pending responsibility: never overwrite them.
  if (inspected.state === "UNREADABLE") return { status: "blocked", message: "原请求记录无法读取；请保留当前页面并联系客服核对。" };
  if (inspected.intent && options.refuseExisting) {
    return { status: "recovery-unresolved", error: { status: 409, code: options.pendingCode ?? "ORIGINAL_REQUEST_PENDING", message: options.pendingMessage ?? "已有一笔结果未确认的原申请，请到订单详情按原请求查询/恢复，不要重复提交。" } };
  }
  const existing = inspected.intent;
  let key: string, frozenBody: Record<string, unknown>, frozenContext: Record<string, unknown> | undefined;
  if (existing) {
    key = existing.key;
    frozenBody = existing.body;
    frozenContext = existing.context;
  } else {
    const saved = saveIntent({ userId, kind: options.kind, resourceId: options.resourceId, key: options.keyFactory(), body: options.body, context: options.context });
    if (!saved.persisted) return { status: "blocked", message: "浏览器会话存储不可用，无法保存原请求恢复信息；为避免产生不可恢复的写入，本次提交已阻止。" };
    key = saved.intent.key;
    frozenBody = saved.intent.body;
    frozenContext = saved.intent.context;
  }
  try {
    // The subject is passed in rather than looked up when the request is sent, so a delayed
    // intent for A can never be executed with a subject that was registered later for B.
    const value = await options.request(key, frozenBody, frozenContext, userId);
    clearIntent(userId, options.kind, options.resourceId);
    return { status: "ok", value };
  } catch (error) {
    const typed = guardedErrorOf(error);
    if (typed.status === 401 || typed.code === "UNAUTHENTICATED") return { status: "unauthorized", error: typed };
    if (typed.status === 0 || typed.status >= 500) return { status: "unknown", error: typed };
    if (existing) return { status: "recovery-unresolved", error: typed };
    clearIntent(userId, options.kind, options.resourceId);
    return { status: "definitive", error: typed };
  }
}
