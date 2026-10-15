/**
 * ADM-SELF-SETTINGS-UI-1 · 本人设置局部 API 适配（合同 §0.1 / §5.1）。
 *
 * 只做路径拼接与信封透传：复用既有 `adminRequest`（Cookie、错误对象、全站 401/423 协调都在它里面），
 * 不另造 fetch、不在此处判定业务成功。响应体一律以 `unknown` 返回，由 `model.ts` 的合同校验收敛。
 */

import { adminRequest } from "../../api";
import { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT } from "./model.ts";

export function readProfile(): Promise<unknown> {
  return adminRequest<unknown>("/self/profile");
}

export function updateProfileDisplayName(displayName: string): Promise<unknown> {
  // 合同 §1.2 请求体严格：出现 displayName 以外的键即 400 unknown_field。
  return adminRequest<unknown>("/self/profile", { displayName });
}

export function readSessions(): Promise<unknown> {
  return adminRequest<unknown>("/self/sessions");
}

export function revokeSession(sessionId: string): Promise<unknown> {
  return adminRequest<unknown>("/self/sessions/revoke", { sessionId });
}

export function revokeOtherSessions(input: { sessionIds: string[] }): Promise<unknown> {
  // v2.0：只提交用户确认的固定集合，不能重试时从最新列表重新选目标。
  return adminRequest<unknown>("/self/sessions/revoke-others", { sessionIds: input.sessionIds });
}

export function readSecurityActivity(input: { cursor: string | null; action: string; limit?: number }): Promise<unknown> {
  const limit = Math.min(Math.max(input.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT);
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.action) params.set("action", input.action);
  return adminRequest<unknown>(`/self/security-activity?${params.toString()}`);
}
