import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { conflict, fingerprintRequest, invalid, notFound, withIdempotency } from "../supply/supply-util";
import { SecurityApiError } from "./security-core";

/** 内部高危标识的写操作名；回执与幂等作用域都用它。 */
export const USER_RISK_FLAG_OPERATION = "user.risk.flag";

export type UserRiskFlagBody = { flagged: boolean; expectedRevision: number | null };

export function parseUserRiskFlagBody(body: unknown): UserRiskFlagBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Risk flag body is invalid");
  const record = body as Record<string, unknown>;
  if (typeof record.flagged !== "boolean") throw invalid("Risk flag body is invalid");
  if (record.expectedRevision !== undefined && record.expectedRevision !== null) {
    if (!Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 0) throw invalid("Risk flag revision is invalid");
  }
  return { flagged: record.flagged, expectedRevision: record.expectedRevision === undefined || record.expectedRevision === null ? null : Number(record.expectedRevision) };
}

/**
 * 标记或取消用户的内部高危标识。
 * 只写这一个布尔事实：不联动账号状态、信用、上架或订单资格，也不发用户侧通知。
 * 幂等键、CAS 版本与审计事件沿用既有写法；超时或结果未知不换键重试。
 */
export async function writeUserRiskFlag(
  client: PoolClient,
  actor: { adminId: string; sessionId: string; requestId?: string },
  input: { userId: string; flagged: boolean; expectedRevision: number | null },
  idempotencyKey: string,
): Promise<{ status: number; body: unknown; replayed: boolean }> {
  const fingerprint = fingerprintRequest(USER_RISK_FLAG_OPERATION, input.userId, { flagged: input.flagged, expectedRevision: input.expectedRevision });
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: actor.adminId, operation: USER_RISK_FLAG_OPERATION, resourceId: input.userId },
    idempotencyKey,
    fingerprint,
    async () => undefined,
    async () => {
      if (!(await client.query(`SELECT 1 FROM zzsh_auth_user."user" WHERE id=$1 FOR SHARE`, [input.userId])).rowCount) throw notFound();
      const current = (await client.query<{ flagged: boolean; revision: number }>(
        `SELECT flagged, revision FROM zzsh_iam.user_risk_flag WHERE user_id=$1 FOR UPDATE`, [input.userId],
      )).rows[0];
      const currentFlagged = current?.flagged === true;
      const currentRevision = current?.revision ?? 0;
      if (input.expectedRevision !== null && input.expectedRevision !== currentRevision) {
        throw conflict("User risk flag changed; reload before retrying");
      }
      if (currentFlagged === input.flagged) {
        return { status: 200, body: { userId: input.userId, flagged: currentFlagged, revision: currentRevision, changed: false } };
      }
      const revision = currentRevision + 1;
      await client.query(
        `INSERT INTO zzsh_iam.user_risk_flag (user_id, flagged, revision, updated_at, updated_by)
         VALUES ($1,$2,$3,now(),$4)
         ON CONFLICT (user_id) DO UPDATE SET flagged=EXCLUDED.flagged, revision=EXCLUDED.revision, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [input.userId, input.flagged, revision, actor.adminId],
      );
      const auditId = `audit_${randomUUID().replaceAll("-", "")}`;
      await client.query(
        `INSERT INTO "zzsh_iam"."audit_event"
          ("id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id", "outcome", "request_id", "reason", "occurred_at", "details")
         VALUES ($1, 'admin', $2, $3, $4, 'user', $5, 'SUCCESS', $6, $7, clock_timestamp(), $8::jsonb)`,
        [auditId, actor.adminId, actor.sessionId, `${USER_RISK_FLAG_OPERATION}.changed`, input.userId, actor.requestId ?? null,
          input.flagged ? "标记内部高危" : "取消内部高危",
          JSON.stringify({ before: currentFlagged, after: input.flagged, revision })],
      );
      return { status: 200, body: { userId: input.userId, flagged: input.flagged, revision, changed: true, auditEventId: auditId } };
    },
  );
  return result;
}
