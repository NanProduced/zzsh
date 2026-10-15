import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { createAuthSchema } from "./auth-schema";
import { AdminSecurityCommandError } from "./admin-security-commands";

type AuthEndpoint = Parameters<typeof import("better-auth/cookies").setSessionCookie>[0];

export type AdminCommandSessionContext = { userId: string; sessionId: string };

type SessionGuardRow = {
  locked: boolean;
  pinHash: string | null;
  pinFailures: number;
  expiresAt: Date;
  suspended: boolean;
  twoFactorEnabled: boolean;
};

/**
 * 敏感命令在**事务内**重新确认授权，不信任事务前读到的会话快照。
 *
 * 锁顺序与既有 freeze 一致：先 `zzsh_iam.admin_security`，再 `zzsh_auth_admin.session`，
 * 避免与"冻结→撤销会话"互等。会话缺失/过期/撤销/账号被冻结都按原语义区分，
 * 回执存在不构成权限凭证。`allowPending` 保留首登改密（PENDING_ENROLLMENT、尚未绑定 2FA）
 * 的合法路径，不把它套用到 ACTIVE 才允许的 PIN 与备份码命令。
 */
export async function assertAdminCommandAuthorizedInTransaction(
  client: PoolClient,
  context: AdminCommandSessionContext,
  mode: { allowPending?: boolean } = {},
): Promise<{ locked: boolean; pinHash: string | null; pinFailures: number }> {
  const security = (await client.query<{ status: string }>(
    `SELECT "status" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
    [context.userId],
  )).rows[0];
  if (!security || security.status === "FROZEN") {
    throw new AdminSecurityCommandError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable", "account_unavailable");
  }
  if (!mode.allowPending && security.status !== "ACTIVE") {
    throw new AdminSecurityCommandError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required", "additional_verification_required");
  }
  const session = (await client.query<SessionGuardRow>(
    `SELECT s."locked" AS "locked", s."pinHash" AS "pinHash", s."pinFailures" AS "pinFailures",
            s."expiresAt" AS "expiresAt", u."suspended" AS "suspended", u."twoFactorEnabled" AS "twoFactorEnabled"
       FROM "zzsh_auth_admin"."session" s
       JOIN "zzsh_auth_admin"."user" u ON u."id" = s."userId"
      WHERE s."id" = $1 AND s."userId" = $2
      FOR UPDATE OF s`,
    [context.sessionId, context.userId],
  )).rows[0];
  if (!session || session.suspended || new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new AdminSecurityCommandError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required", "authentication_required");
  }
  if (!mode.allowPending && session.twoFactorEnabled !== true) {
    throw new AdminSecurityCommandError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required", "additional_verification_required");
  }
  if (session.locked) {
    throw new AdminSecurityCommandError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked", "session_locked");
  }
  return { locked: session.locked, pinHash: session.pinHash, pinFailures: session.pinFailures };
}

/**
 * SDK `session.create` 钩子的事务内版本。
 *
 * adminAuth 原 `databaseHooks` 通过 `options.pool` 取连接；在本包的外层事务里，
 * SDK `create.after` 走 `queueAfterTransactionHook`，而 `runWithAdapter` 下
 * `isTransactionActive=false` 会让它在 COMMIT 之前立即执行——于是
 * "外层已持有 admin_security 行锁 + 钩子用另一连接 UPDATE 同一行" 互相等待。
 * 这里把同样的检查与认证时间更新绑定到当前事务 client：语义不变、顺序不变，
 * 只是不再跳出事务。
 */
export function adminSessionCreationHooks(client: PoolClient) {
  return {
    session: {
      create: {
        before: async (data: { userId: string }) => {
          const user = await client.query<{ suspended: boolean }>(
            `SELECT "suspended" FROM "zzsh_auth_admin"."user" WHERE "id" = $1`,
            [data.userId],
          );
          if (user.rows[0]?.suspended) {
            throw new AdminSecurityCommandError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable", "account_unavailable");
          }
          const security = await client.query<{ status: string }>(
            `SELECT "status" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
            [data.userId],
          );
          if (!security.rows[0] || security.rows[0].status === "FROZEN") {
            throw new AdminSecurityCommandError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable", "account_unavailable");
          }
          return { data };
        },
        after: async (session: { userId: string }) => {
          // 原钩子语义：只有 ACTIVE 且已启用 2FA 的管理员刷新完整认证时间。
          await client.query(
            `UPDATE "zzsh_iam"."admin_security" AS security
                SET "last_full_authenticated_at" = clock_timestamp(),
                    "updated_at" = clock_timestamp()
               FROM "zzsh_auth_admin"."user" AS admin_user
              WHERE security."admin_user_id" = $1
                AND admin_user."id" = security."admin_user_id"
                AND security."status" = 'ACTIVE'
                AND admin_user."twoFactorEnabled" = true`,
            [session.userId],
          );
        },
      },
    },
  };
}

/**
 * 在既有 PG 事务内用 Better Auth 自己的会话生成能力创建管理员会话。
 *
 * 机制借鉴 user-auth-session.ts（用户 realm），但 schema、门禁、钩子与绝对期限
 * 全部来自 admin realm：session.expiresIn 仍是 7 天，不复制用户端 30 天规则，
 * 也不把用户 realm 的服务直接用于管理员。
 */
export async function createTransactionalAdminSession(client: PoolClient, ctx: AuthEndpoint, userId: string) {
  const [{ drizzleAdapter }, { createInternalAdapter }, { runWithAdapter }] = await Promise.all([
    import("@better-auth/drizzle-adapter"), import("better-auth/db"), import("@better-auth/core/context"),
  ]);
  const adapter = drizzleAdapter(drizzle(client), { provider: "pg", schema: createAuthSchema("zzsh_auth_admin"), transaction: false })(ctx.context.options);
  const internal = createInternalAdapter(adapter, {
    options: ctx.context.options,
    logger: ctx.context.logger,
    generateId: ctx.context.generateId,
    // 只注入绑定当前事务 client 的钩子；ctx.context.options.databaseHooks 走 pool，会与外层事务互等。
    hooks: [{ source: "admin-security-command", hooks: adminSessionCreationHooks(client) }],
  });
  // HTTP handler 把池适配器装进了 async context；必须显式覆盖，
  // 否则 SDK 的读写会跳出本事务，看不到事务内刚更新的凭据。
  return runWithAdapter(adapter, async () => {
    const user = await internal.findUserById(userId);
    if (!user) throw new AdminSecurityCommandError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required", "authentication_required");
    if ((user as typeof user & { suspended?: boolean }).suspended) {
      throw new AdminSecurityCommandError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable", "account_unavailable");
    }
    const session = await internal.createSession(userId, false);
    if (!session) throw new Error("Admin session creation failed");
    return { user, session };
  });
}
