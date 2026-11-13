import type { PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import {
  assertAdminContextInTransaction,
  type AdminContext,
  type AuthSecurityOptions,
} from "./auth-security";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";

const DISPLAY_NAME_MAX_CODE_POINTS = 120;

// 与前端 displayNameIssue 同规则：C0/C1 控制字符不允许，按 Unicode 码点计数。
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function invalid(reason: string, message = "Request body is invalid"): never {
  throw Object.assign(new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message), { reason });
}

/** 请求体严格只有 displayName；任何额外键都拒绝，目标永远来自当前会话。 */
export function parseDisplayNameUpdate(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("invalid_body");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "displayName") invalid("unknown_field");
  const raw = (body as Record<string, unknown>).displayName;
  if (typeof raw !== "string") invalid("display_name_invalid");
  if (CONTROL_CHARACTERS.test(raw)) invalid("display_name_invalid");
  const name = raw.trim();
  if (!name || [...name].length > DISPLAY_NAME_MAX_CODE_POINTS) invalid("display_name_invalid");
  return name;
}

export type SelfProfileRow = {
  id: string;
  username: string | null;
  displayUsername: string | null;
  name: string;
  image: string | null;
  updatedAt: Date | string;
};

type LockedSelfRow = SelfProfileRow & { suspended: boolean; status: string };

/**
 * 本人显示名称写入：只作用于当前会话主体，不需要 admin.account.update。
 * 更新与 admin.account.updated 审计同事务；并发按行锁串行，最后写入生效。
 */
export async function updateSelfDisplayName(
  context: Pick<AdminContext, "userId" | "sessionId">,
  body: unknown,
  requestId: string,
  options: Pick<AuthSecurityOptions, "pool">,
): Promise<SelfProfileRow> {
  const name = parseDisplayNameUpdate(body);
  return withTransaction(options.pool, async (client: PoolClient) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const locked = (await client.query<LockedSelfRow>(
      `SELECT u."id", u."username", u."displayUsername", u."name", u."image", u."updatedAt",
              u."suspended", s."status"
         FROM "zzsh_auth_admin"."user" u
         JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
        WHERE u."id" = $1
        FOR UPDATE OF u, s`,
      [context.userId],
    )).rows[0];
    if (!locked || locked.suspended) {
      throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
    }
    if (locked.status !== "ACTIVE") {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required");
    }
    const updated = (await client.query<SelfProfileRow>(
      `UPDATE "zzsh_auth_admin"."user"
          SET "name" = $1, "updatedAt" = clock_timestamp()
        WHERE "id" = $2
        RETURNING "id", "username", "displayUsername", "name", "image", "updatedAt"`,
      [name, context.userId],
    )).rows[0];
    if (!updated) {
      throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
    }
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.account.updated",
      objectType: "admin_user",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      details: {
        username: locked.username,
        before: { name: locked.name },
        after: { name: updated.name },
      },
    });
    return updated;
  });
}
