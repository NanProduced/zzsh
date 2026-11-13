import type { PoolClient } from "pg";

import { forbidden, sha256Hex } from "../supply/supply-util";
import {
  TIMESTAMP_TEXT,
  encodeKeysetCursor,
  parseKeysetCursor,
  type AdminDirectoryViewer,
} from "./user-directory-list";

/** User-object audit history for the directory takeover: operations and migration facts on one user. */
export const USER_AUDIT_OBJECT_TYPES = ["user", "user_account", "user_identity_state", "user_rental_membership"] as const;

type UserAuditRow = {
  id: string;
  actorType: string;
  actorAdminUsername: string | null;
  actorAdminDisplayUsername: string | null;
  actorAdminName: string | null;
  actorUserName: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  occurredAt: string;
  details: Record<string, unknown>;
};

export async function listUserAuditEvents(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  page: { limit: number; cursor?: string },
  sanitizeDetail: (value: unknown) => unknown,
): Promise<Record<string, unknown>> {
  if (!viewer.auditRead) throw forbidden("Audit reading requires admin.audit.read");
  const filterKey = sha256Hex(
    JSON.stringify({ scope: "admin-user-audit", principal: viewer.adminId, isBoss: viewer.isBoss, authorizationKey: viewer.authorizationKey ?? null, userId, limit: page.limit }),
  );
  const cursor = parseKeysetCursor(page.cursor, filterKey);
  const values: unknown[] = [userId, [...USER_AUDIT_OBJECT_TYPES]];
  const conditions = [`e.object_id = $1`, `e.object_type = ANY($2::text[])`, `e.actor_type IN ('admin', 'user', 'system')`];
  if (!viewer.isBoss) {
    conditions.push(`e.actor_type = 'admin' AND e.actor_id = $${values.push(viewer.adminId)}`);
  }
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  conditions.push(`($${cursorTime}::timestamptz IS NULL OR e.occurred_at < $${cursorTime}::timestamptz OR (e.occurred_at = $${cursorTime}::timestamptz AND e.id < $${cursorId}))`);
  const rows = (
    await client.query<UserAuditRow>(
      `SELECT e.id, e.actor_type AS "actorType",
              admin_u.username AS "actorAdminUsername", admin_u."displayUsername" AS "actorAdminDisplayUsername", admin_u.name AS "actorAdminName",
              user_u.name AS "actorUserName",
              e.action, e.object_type AS "objectType", e.object_id AS "objectId", e.outcome, e.reason,
              e.request_id AS "requestId",
              to_char(e.occurred_at ${TIMESTAMP_TEXT}) AS "occurredAt",
              e.details
         FROM zzsh_iam.audit_event e
         LEFT JOIN zzsh_auth_admin."user" admin_u ON e.actor_type = 'admin' AND admin_u.id = e.actor_id
         LEFT JOIN zzsh_auth_user."user" user_u ON e.actor_type = 'user' AND user_u.id = e.actor_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT $${limitParameter}`,
      values,
    )
  ).rows;
  const items = rows.slice(0, page.limit);
  const hasMore = rows.length > page.limit;
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      eventId: row.id,
      actorType: row.actorType,
      actor: row.actorType === "admin"
        ? { username: row.actorAdminUsername ?? "未知管理员", displayUsername: row.actorAdminDisplayUsername ?? row.actorAdminUsername ?? "未知管理员", name: row.actorAdminName ?? "未知管理员" }
        : row.actorType === "user"
          ? { username: null, displayUsername: null, name: row.actorUserName ?? "用户本人" }
          : { username: null, displayUsername: null, name: "系统" },
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      outcome: row.outcome,
      reason: row.reason,
      requestId: row.requestId,
      occurredAt: row.occurredAt,
      details: sanitizeDetail(row.details),
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.occurredAt, id: last.id }) : null,
    limit: page.limit,
  };
}
