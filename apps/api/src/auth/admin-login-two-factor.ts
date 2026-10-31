import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

/**
 * 账号是否选择了「登录时不验证 2FA」。
 * 只有已激活、且显式设为 false 的账号才算关闭；列不存在（迁移未执行）或查询失败时一律按需要验证处理（失败即安全）。
 */
export async function adminLoginTwoFactorOptedOut(pool: Queryable, userId: string): Promise<boolean> {
  try {
    const result = await pool.query<{ optedOut: boolean }>(
      `SELECT ("login_two_factor_required" = false AND "status" = 'ACTIVE') AS "optedOut"
         FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [userId],
    );
    return result.rows[0]?.optedOut === true;
  } catch {
    return false;
  }
}

/** 读取偏好；列不可用时返回 undefined，界面据此显示「未接入」而不是猜测。 */
export async function readAdminLoginTwoFactorRequired(pool: Queryable, userId: string): Promise<boolean | undefined> {
  try {
    const result = await pool.query<{ required: boolean }>(
      `SELECT "login_two_factor_required" AS "required" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [userId],
    );
    const value = result.rows[0]?.required;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

type AfterHook = { matcher: (context: any) => boolean; handler: (ctx: any) => Promise<unknown> };
type PluginWithAfterHooks = { hooks?: { after?: AfterHook[] } };

/**
 * 包装 SDK twoFactor() 的登录后钩子：账号关闭了登录 2FA 时跳过登录挑战，直接保留密码登录建立的会话。
 * 2FA 绑定本身（twoFactorEnabled 与 TOTP 密钥）不变，敏感操作的再验证照常要求动态码。
 */
/**
 * 注意：SDK 的 after 钩子本身已是 createAuthMiddleware 产物，dispatch 以 { response, headers } 读取其返回值。
 * 这里必须原样透传内层结果；再套一层 createAuthMiddleware 会把 { response, headers } 嵌进 response，
 * 导致登录 200 却丢失 twoFactorRedirect 与 two_factor Cookie（会话已被 SDK 删除）→ 前端停在登录页。
 */
export function withAdminLoginTwoFactorPreference<T extends PluginWithAfterHooks>(
  plugin: T,
  pool: Queryable,
): T {
  const after = plugin.hooks?.after;
  if (!after) return plugin;
  const wrapped = after.map((hook) => ({
    ...hook,
    handler: async (ctx: any) => {
      const user = ctx?.context?.newSession?.user;
      // 跳过挑战：返回空结果，保留密码登录已建立的会话与 Cookie。
      if (user?.twoFactorEnabled && typeof user.id === "string" && await adminLoginTwoFactorOptedOut(pool, user.id)) return { response: undefined, headers: undefined };
      return hook.handler(ctx);
    },
  }));
  return { ...plugin, hooks: { ...plugin.hooks, after: wrapped } };
}
