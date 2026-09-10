import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import {
  queueAdminSecurityNotification,
  recordAudit,
  setAuditContext,
  withTransaction,
  type AdminSecurityNotification,
} from "./auth-security";

const DISASTER_RECOVERY_TTL_MS = 10 * 60 * 1000;
const DISASTER_RECOVERY_REQUEST_PREFIX = "req_disaster_";

export type DisasterRecoveryIssueInput = {
  targetAdminId: string;
  operatorId: string;
  offlineConfirmationId: string;
  targetRecoveryCredentialHash: string;
};

export type DisasterRecoveryIssueResult = {
  recoveryRequestId: string;
  targetAdminId: string;
  requestId: string;
  status: "ISSUED";
  expiresAt: Date;
  notificationTargetIds: string[];
  reissued: boolean;
};

export class DisasterRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisasterRecoveryError";
  }
}

function opaqueField(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DisasterRecoveryError(`${field} is invalid`);
  }
  return value;
}

function referenceField(value: string, field: string): string {
  const result = opaqueField(value.trim(), field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,127}$/.test(result)) throw new DisasterRecoveryError(`${field} is invalid`);
  return result;
}

function credentialHashField(value: string): string {
  const result = opaqueField(value.trim(), "target recovery credential hash");
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new DisasterRecoveryError("target recovery credential hash is invalid");
  return result.toLowerCase();
}

export async function issueDisasterRecovery(
  pool: Pool,
  input: DisasterRecoveryIssueInput,
): Promise<DisasterRecoveryIssueResult> {
  const targetAdminId = referenceField(input.targetAdminId, "target administrator");
  const operatorId = referenceField(input.operatorId, "operator identity");
  const offlineConfirmationId = referenceField(input.offlineConfirmationId, "offline confirmation record");
  const targetRecoveryCredentialHash = credentialHashField(input.targetRecoveryCredentialHash);
  if (operatorId === targetAdminId) throw new DisasterRecoveryError("operator and recovery target must be different");

  const requestId = `${DISASTER_RECOVERY_REQUEST_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const expiresAt = new Date(Date.now() + DISASTER_RECOVERY_TTL_MS);

  return withTransaction(pool, async (client) => {
    // ponytail: one advisory gate serializes the rare controlled command with bootstrap; normal web paths keep their existing lock order.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [805101]);

    const account = await client.query<{ id: string; password: string | null }>(
      `SELECT "id", "password"
         FROM "zzsh_auth_admin"."account"
        WHERE "userId" = $1 AND "providerId" = 'credential'
        FOR UPDATE`,
      [targetAdminId],
    );
    const target = await client.query<{
      status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
      isBoss: boolean;
      firstActivatedAt: Date | null;
    }>(
      `SELECT "status", "is_boss" AS "isBoss", "first_activated_at" AS "firstActivatedAt"
         FROM "zzsh_iam"."admin_security"
        WHERE "admin_user_id" = $1
        FOR UPDATE`,
      [targetAdminId],
    );
    const targetRow = target.rows[0];
    const accountRow = account.rows[0];

    const targetUser = await client.query<{ twoFactorEnabled: boolean; email: string; phoneNumber: string | null }>(
      `SELECT "twoFactorEnabled", "email", "phoneNumber"
         FROM "zzsh_auth_admin"."user"
        WHERE "id" = $1
        FOR UPDATE`,
      [targetAdminId],
    );
    const targetUserRow = targetUser.rows[0];
    const previousDisasterRecovery = await client.query<{
      id: string;
      status: "ISSUED" | "COMPLETED";
      recoveryTokenHash: string | null;
      completedAt: Date | null;
    }>(
      `SELECT "id", "status", "recovery_token_hash" AS "recoveryTokenHash", "completed_at" AS "completedAt"
         FROM "zzsh_iam"."admin_recovery_request"
        WHERE "target_admin_user_id" = $1
          AND "recovery_method" = 'DISASTER_CLI'
          AND (
            ("status" = 'ISSUED' AND "recovery_token_hash" IS NOT NULL)
            OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL)
          )
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 1
        FOR UPDATE`,
      [targetAdminId],
    );
    const initialRecovery = targetRow?.status === "ACTIVE" && Boolean(accountRow?.password) && Boolean(targetUserRow?.twoFactorEnabled);
    const continuationRecovery = targetRow?.status === "PENDING_ENROLLMENT" && Boolean(targetRow.firstActivatedAt) && Boolean(previousDisasterRecovery.rows[0]);
    if (!targetRow?.isBoss || !targetRow.firstActivatedAt || !accountRow || !targetUserRow || (!initialRecovery && !continuationRecovery)) {
      throw new DisasterRecoveryError("recovery target is not eligible for controlled disaster recovery");
    }

    const bosses = await client.query<{ adminId: string }>(
      `SELECT "admin_user_id" AS "adminId"
         FROM "zzsh_iam"."admin_security"
        WHERE "is_boss" = true
        ORDER BY "admin_user_id"`,
    );
    if (bosses.rows.length !== 2) throw new DisasterRecoveryError("disaster recovery requires exactly two boss accounts");

    const bossIds = new Set(bosses.rows.map((row) => row.adminId));
    if (!bossIds.has(targetAdminId)) throw new DisasterRecoveryError("recovery target must be a boss account");

    const notificationTargets = await client.query<{ adminId: string; notificationTargetId: string }>(
      `SELECT s."admin_user_id" AS "adminId", n."id" AS "notificationTargetId"
         FROM "zzsh_iam"."admin_security" s
         JOIN "zzsh_iam"."admin_recovery_notification_target" n
           ON n."admin_user_id" = s."admin_user_id" AND n."active" = true
        WHERE s."is_boss" = true
        ORDER BY s."admin_user_id", n."id"`,
    );
    if (
      notificationTargets.rows.length !== bosses.rows.length ||
      notificationTargets.rows.some((row, index) => row.adminId !== bosses.rows[index]?.adminId)
    ) {
      throw new DisasterRecoveryError("both bosses require one pre-registered recovery notification target");
    }

    await setAuditContext(client, "maintenance", operatorId, undefined, requestId);
    await client.query(
      `UPDATE "zzsh_iam"."admin_recovery_request"
          SET "status" = 'EXPIRED', "recovery_token_hash" = NULL
        WHERE "target_admin_user_id" = $1 AND "status" IN ('PENDING', 'ISSUED')`,
      [targetAdminId],
    );
    await client.query(
      `UPDATE "zzsh_auth_admin"."account"
          SET "password" = NULL, "updatedAt" = clock_timestamp()
        WHERE "id" = $1`,
      [accountRow.id],
    );
    await client.query(`DELETE FROM "zzsh_auth_admin"."twoFactor" WHERE "userId" = $1`, [targetAdminId]);
    await client.query(
      `UPDATE "zzsh_auth_admin"."user"
          SET "twoFactorEnabled" = false, "updatedAt" = clock_timestamp()
        WHERE "id" = $1`,
      [targetAdminId],
    );
    await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [targetAdminId]);
    await client.query(
      `DELETE FROM "zzsh_auth_admin"."verification" verification
        USING "zzsh_auth_admin"."user" target_user
        WHERE target_user."id" = $1
          AND verification."identifier" IN (target_user."id", target_user."email", target_user."phoneNumber")`,
      [targetAdminId],
    );
    await client.query(
      `UPDATE "zzsh_iam"."admin_security"
          SET "status" = 'PENDING_ENROLLMENT',
              "bootstrap_expires_at" = $2,
              "bootstrap_used_at" = NULL,
              "updated_at" = clock_timestamp()
        WHERE "admin_user_id" = $1`,
      [targetAdminId, new Date(Date.now() + 15 * 60 * 1000)],
    );

    const recoveryRequestId = `recovery_${randomUUID().replaceAll("-", "")}`;
    await client.query(
      `INSERT INTO "zzsh_iam"."admin_recovery_request"
        ("id", "target_admin_user_id", "requested_by", "status", "recovery_token_hash", "expires_at", "recovery_method", "offline_confirmation_id")
       VALUES ($1, $2, $3, 'ISSUED', $4, $5, 'DISASTER_CLI', $6)`,
      [recoveryRequestId, targetAdminId, operatorId, targetRecoveryCredentialHash, expiresAt, offlineConfirmationId],
    );

    const notificationTargetIds = notificationTargets.rows.map((row) => row.notificationTargetId);
    await recordAudit(client, {
      actorType: "maintenance",
      actorId: operatorId,
      action: "admin.recovery.disaster.issued",
      objectType: "admin_recovery_request",
      objectId: recoveryRequestId,
      outcome: "SUCCESS",
      requestId,
      details: {
        targetAdminId,
        operatorId,
        offlineConfirmationId,
        recoveryMethod: "DISASTER_CLI",
        targetRecoveryCredential: "hash_only",
        reissued: continuationRecovery,
        supersededRecoveryRequestId: previousDisasterRecovery.rows[0]?.id ?? null,
        preRegisteredNotificationTargetIds: notificationTargetIds,
      },
    });

    for (const bossId of bosses.rows.map((row) => row.adminId)) {
      const notification: AdminSecurityNotification = {
        event: "admin.recovery.disaster.issued",
        actorId: operatorId,
        targetAdminId: bossId,
        requestId,
      };
      await queueAdminSecurityNotification(client, notification);
    }

    return {
      recoveryRequestId,
      targetAdminId,
      requestId,
      status: "ISSUED",
      expiresAt,
      notificationTargetIds,
      reissued: continuationRecovery,
    };
  });
}
