import type { PoolClient } from "pg";

import { recordAudit, SecurityApiError } from "../auth/security-core";

/**
 * 开租清单自动确认等待期。默认 40 分钟；修改只影响之后新生成的清单，
 * 已生成清单在 INSERT 时已冻结 revision 和截止时间。
 */
export const OPENING_AUTO_CONFIRM_DEFAULT_MINUTES = 40;
export const OPENING_AUTO_CONFIRM_MIN_MINUTES = 1;
export const OPENING_AUTO_CONFIRM_MAX_MINUTES = 10080;
export const OPENING_AUTO_CONFIRM_POLICY_ACTION = "order.opening.auto_confirm.policy.updated";

export type OpeningAutoConfirmPolicy = {
  waitMinutes: number;
  revision: string;
  available: boolean;
};
export type OpeningAutoConfirmPolicyInput = { waitMinutes: number; expectedRevision: string };

const unavailable = () => new SecurityApiError(503, "INTERNAL_ERROR", "Opening auto-confirm policy is not installed");
const columns = `wait_minutes AS "waitMinutes",revision::text`;

export function validateOpeningAutoConfirmPolicy(input: OpeningAutoConfirmPolicyInput): void {
  if (!Number.isInteger(input.waitMinutes)
    || input.waitMinutes < OPENING_AUTO_CONFIRM_MIN_MINUTES
    || input.waitMinutes > OPENING_AUTO_CONFIRM_MAX_MINUTES
    || typeof input.expectedRevision !== "string" || !/^[1-9]\d{0,18}$/.test(input.expectedRevision)) {
    throw new SecurityApiError(400, "INVALID_ARGUMENT", "开租自动确认等待期须为 1 至 10080 的整数分钟");
  }
}

export async function readOpeningAutoConfirmPolicy(client: Pick<PoolClient, "query">): Promise<OpeningAutoConfirmPolicy> {
  const available = (await client.query("SELECT to_regclass('zzsh_order.opening_auto_confirm_policy') IS NOT NULL AS available")).rows[0]?.available;
  if (available !== true) return { waitMinutes: OPENING_AUTO_CONFIRM_DEFAULT_MINUTES, revision: "0", available: false };
  const row = (await client.query<Omit<OpeningAutoConfirmPolicy, "available">>(
    `SELECT ${columns} FROM zzsh_order.opening_auto_confirm_policy WHERE singleton=true`,
  )).rows[0];
  if (!row || !Number.isInteger(row.waitMinutes) || !/^[1-9]\d{0,18}$/.test(row.revision)) throw unavailable();
  return { ...row, available: true };
}

export async function updateOpeningAutoConfirmPolicy(
  client: PoolClient,
  actor: { id: string; sessionId: string },
  input: OpeningAutoConfirmPolicyInput,
  requestId: string,
): Promise<{ policy: OpeningAutoConfirmPolicy; changed: boolean }> {
  validateOpeningAutoConfirmPolicy(input);
  const available = (await client.query("SELECT to_regclass('zzsh_order.opening_auto_confirm_policy') IS NOT NULL AS available")).rows[0]?.available;
  if (available !== true) throw unavailable();
  const before = (await client.query<Omit<OpeningAutoConfirmPolicy, "available">>(
    `SELECT ${columns} FROM zzsh_order.opening_auto_confirm_policy WHERE singleton=true FOR UPDATE`,
  )).rows[0];
  if (!before) throw unavailable();
  if (before.revision !== input.expectedRevision) {
    throw new SecurityApiError(409, "CONFLICT", "设置已更改，请重新读取后再保存");
  }
  if (before.waitMinutes === input.waitMinutes) return { policy: { ...before, available: true }, changed: false };
  const policy = (await client.query<Omit<OpeningAutoConfirmPolicy, "available">>(
    `UPDATE zzsh_order.opening_auto_confirm_policy
        SET wait_minutes=$1, revision=revision+1, updated_by_admin_id=$2, updated_at=clock_timestamp()
      WHERE singleton=true RETURNING ${columns}`,
    [input.waitMinutes, actor.id],
  )).rows[0]!;
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId,
    action: OPENING_AUTO_CONFIRM_POLICY_ACTION, objectType: "opening_auto_confirm_policy", objectId: "global", outcome: "SUCCESS",
    details: { before, after: policy, appliesTo: "FUTURE_OPENINGS" },
  });
  return { policy: { ...policy, available: true }, changed: true };
}
