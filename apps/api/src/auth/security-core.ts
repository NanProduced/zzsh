import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";

export type AuditOutcome = "SUCCESS" | "FAILURE";

export class SecurityApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: (typeof API_V1_ERROR_CODES)[keyof typeof API_V1_ERROR_CODES],
    message: string,
  ) {
    super(message);
  }
}

export async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the primary error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function setAuditContext(
  client: PoolClient,
  actorType: string,
  actorId: string | undefined,
  sessionId: string | undefined,
  requestId: string,
): Promise<void> {
  await client.query(
    "SELECT set_config('zzsh.actor_type', $1, true), set_config('zzsh.actor_id', $2, true), set_config('zzsh.session_id', $3, true), set_config('zzsh.request_id', $4, true)",
    [actorType, actorId ?? "", sessionId ?? "", requestId],
  );
}

export async function recordAudit(
  client: PoolClient,
  values: {
    actorType: string;
    actorId?: string;
    sessionId?: string;
    action: string;
    objectType: string;
    objectId?: string;
    outcome: AuditOutcome;
    requestId: string;
    reason?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "zzsh_iam"."audit_event"
      ("id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id", "outcome", "request_id", "reason", "occurred_at", "details")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp(), $11::jsonb)`,
    [
      `audit_${randomUUID().replaceAll("-", "")}`,
      values.actorType,
      values.actorId ?? null,
      values.sessionId ?? null,
      values.action,
      values.objectType,
      values.objectId ?? null,
      values.outcome,
      values.requestId,
      values.reason ?? null,
      JSON.stringify(values.details ?? {}),
    ],
  );
}
