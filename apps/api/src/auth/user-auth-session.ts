import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { createAuthSchema } from "./auth-schema";
import type { Pool } from "pg";
import { normalizeMainlandPhone } from "./phone-number";
import { verifyUserCredentialInTransaction, withTransaction } from "./auth-security";
import { z } from "zod";
import { hasLegacyPhoneConflict } from "./legacy-login";

type AuthEndpoint = Parameters<typeof import("better-auth/cookies").setSessionCookie>[0];

/** Use Better Auth's own session generation on the operation's existing PG transaction. */
export async function createTransactionalUserSession(client: PoolClient, ctx: AuthEndpoint, userId: string, absoluteExpiresAt?: Date) {
  const [{ drizzleAdapter }, { createInternalAdapter }, { runWithAdapter }] = await Promise.all([
    import("@better-auth/drizzle-adapter"), import("better-auth/db"), import("@better-auth/core/context"),
  ]);
  const adapter = drizzleAdapter(drizzle(client), { provider: "pg", schema: createAuthSchema("zzsh_auth_user"), transaction: false })(ctx.context.options);
  const internal = createInternalAdapter(adapter, {
    options: ctx.context.options, logger: ctx.context.logger, generateId: ctx.context.generateId,
    hooks: ctx.context.options.databaseHooks ? [{ source: "user", hooks: ctx.context.options.databaseHooks }] : [],
  });
  // The HTTP handler installs its pool adapter in async context. Override that context too;
  // otherwise SDK reads/inserts escape this transaction and cannot see a newly created user.
  return runWithAdapter(adapter, async () => {
  if (absoluteExpiresAt && absoluteExpiresAt.getTime() <= Date.now()) {
    const { APIError } = await import("better-auth/api");
    throw new APIError("UNAUTHORIZED", { message: "Session expired during security change" });
  }
  const user = await internal.findUserById(userId);
  if (!user) throw new Error("User session subject unavailable");
  const state = await client.query<{ account_status: string }>(`SELECT account_status FROM zzsh_iam.user_identity_state WHERE user_id=$1`, [userId]);
  if ((user as typeof user & { suspended?: boolean }).suspended || state.rows[0]?.account_status !== "ACTIVE") {
    const { APIError } = await import("better-auth/api");
    throw new APIError("FORBIDDEN", { message: "Account unavailable" });
  }
  const session = await internal.createSession(userId, false, absoluteExpiresAt ? { expiresAt: absoluteExpiresAt } : undefined, Boolean(absoluteExpiresAt));
  if (!session) throw new Error("User session creation failed");
  return { user, session };
  });
}

/** Serialize verification, legacy upgrade and session creation with sensitive changes. */
export function buildTransactionalPhoneSignIn(
  pool: Pool, createAuthEndpoint: typeof import("better-auth/api").createAuthEndpoint,
  APIError: typeof import("better-auth/api").APIError,
  setSessionCookie: typeof import("better-auth/cookies").setSessionCookie,
) {
  return createAuthEndpoint("/sign-in/phone-number", {
    method: "POST", metadata: { noStore: true },
    body: z.object({ phoneNumber: z.string(), password: z.string().min(1), rememberMe: z.boolean().optional() }).strict(),
  }, async (ctx) => {
    const body = ctx.body as Record<string, unknown> | undefined;
    const phoneNumber = normalizeMainlandPhone(body?.phoneNumber);
    const password = body?.password;
    if (!phoneNumber || typeof password !== "string" || !password.length || Object.keys(body ?? {}).some(key => !["phoneNumber", "password", "rememberMe"].includes(key))) {
      throw new APIError("BAD_REQUEST", { message: "Invalid authentication request" });
    }
    const authenticated = await withTransaction(pool, async (client) => {
      if (await hasLegacyPhoneConflict(client, phoneNumber)) throw new APIError("UNAUTHORIZED", { message: "Invalid phone number or password" });
      const user = await client.query<{ id: string }>(`SELECT id FROM zzsh_auth_user."user" WHERE "phoneNumber"=$1 FOR UPDATE`, [phoneNumber]);
      const requestId = ctx.headers?.get("x-request-id") ?? "auth-phone-sign-in";
      if (!user.rows[0] || await verifyUserCredentialInTransaction(client,
        (value, hash) => ctx.context.password.verify({ password: value, hash }), ctx.context.password.hash,
        { phoneNumber }, password, requestId) !== "retry") {
        throw new APIError("UNAUTHORIZED", { message: "Invalid phone number or password" });
      }
      return createTransactionalUserSession(client, ctx, user.rows[0].id);
    });
    await setSessionCookie(ctx, authenticated);
    return ctx.json({ status: true, userId: authenticated.user.id });
  });
}
