import type { PoolClient } from "pg";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { recordAudit, SecurityApiError } from "../auth/security-core";

export type SettlementRefundPolicy = { normalDays: number; earlyDays: number; revision: string; available: boolean };
export type SettlementRefundPolicyInput = { normalDays: number; earlyDays: number; expectedRevision: string };
const unavailable = () => new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Settlement refund policy is not installed");
const columns = `normal_days AS "normalDays",early_days AS "earlyDays",revision::text`;

export function validateSettlementRefundPolicy(input: SettlementRefundPolicyInput): void {
  if (!Number.isInteger(input.normalDays) || input.normalDays < 0 || input.normalDays > 365
    || !Number.isInteger(input.earlyDays) || input.earlyDays < 0 || input.earlyDays > 365
    || typeof input.expectedRevision !== "string" || !/^[1-9]\d{0,18}$/.test(input.expectedRevision)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "退款等待期须为 0 至 365 的整数天数");
  }
}

export async function readSettlementRefundPolicy(client: Pick<PoolClient, "query">): Promise<SettlementRefundPolicy> {
  const exists = (await client.query("SELECT to_regclass('zzsh_order.settlement_refund_policy') IS NOT NULL AS available")).rows[0]?.available;
  if (exists !== true) return { normalDays: 0, earlyDays: 7, revision: "0", available: false };
  const row = (await client.query<Omit<SettlementRefundPolicy, "available">>(
    `SELECT ${columns} FROM zzsh_order.settlement_refund_policy WHERE singleton=true`,
  )).rows[0];
  if (!row || !Number.isInteger(row.normalDays) || !Number.isInteger(row.earlyDays) || !/^[1-9]\d{0,18}$/.test(row.revision)) throw unavailable();
  return { ...row, available: true };
}

export async function updateSettlementRefundPolicy(client: PoolClient, actor: { id: string; sessionId: string }, input: SettlementRefundPolicyInput, requestId: string) {
  validateSettlementRefundPolicy(input);
  const exists = (await client.query("SELECT to_regclass('zzsh_order.settlement_refund_policy') IS NOT NULL AS available")).rows[0]?.available;
  if (exists !== true) throw unavailable();
  const before = (await client.query<Omit<SettlementRefundPolicy, "available">>(
    `SELECT ${columns} FROM zzsh_order.settlement_refund_policy WHERE singleton=true FOR UPDATE`,
  )).rows[0];
  if (!before) throw unavailable();
  if (before.revision !== input.expectedRevision) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "设置已更改，请重新读取后再保存");
  if (before.normalDays === input.normalDays && before.earlyDays === input.earlyDays) return { policy: { ...before, available: true }, changed: false };
  const policy = (await client.query<Omit<SettlementRefundPolicy, "available">>(
    `UPDATE zzsh_order.settlement_refund_policy SET normal_days=$1,early_days=$2,revision=revision+1,updated_by_admin_id=$3,updated_at=clock_timestamp()
     WHERE singleton=true RETURNING ${columns}`, [input.normalDays, input.earlyDays, actor.id],
  )).rows[0]!;
  await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId,
    action: "order.settlement.refund_policy.updated", objectType: "settlement_refund_policy", objectId: "global", outcome: "SUCCESS",
    details: { before, after: policy, appliesTo: "FUTURE_SETTLEMENTS" } });
  return { policy: { ...policy, available: true }, changed: true };
}
