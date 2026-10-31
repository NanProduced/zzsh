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
export function withAdminLoginTwoFactorPreference<T extends PluginWithAfterHooks>(
  plugin: T,
  pool: Queryable,
  wrap: (handler: (ctx: any) => Promise<unknown>) => (ctx: any) => Promise<unknown>,
): T {
  const after = plugin.hooks?.after;
  if (!after) return plugin;
  const wrapped = after.map((hook) => ({
    ...hook,
    handler: wrap(async (ctx: any) => {
      const user = ctx?.context?.newSession?.user;
      if (user?.twoFactorEnabled && typeof user.id === "string" && await adminLoginTwoFactorOptedOut(pool, user.id)) return;
      return hook.handler(ctx);
    }),
  }));
  return { ...plugin, hooks: { ...plugin.hooks, after: wrapped } };
}
