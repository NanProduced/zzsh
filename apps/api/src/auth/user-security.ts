import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { normalizeMainlandPhone } from "./phone-number";
import { recordAudit, setAuditContext, withTransaction } from "./security-core";
import { createTransactionalUserSession } from "./user-auth-session";
import { hasLegacyPhoneConflict, readUserPasswordState } from "./legacy-login";

export type UserSecurityDelivery = { code: string; target: string; channel: "phone" | "email"; purpose: string; sentAt: string };
type Purpose = "password" | "email" | "phone" | "recovery";
type Subject = { id: string; name: string; phoneNumber: string | null; email: string; emailVerified: boolean; suspended: boolean; accountStatus: string; securityVersion: number; stamp: string };
type Proof = {
  version: 1; userId: string | null; sessionId: string | null; stamp: string; purpose: Purpose;
  stage: "current" | "target"; channel: "phone" | "email"; target: string | null; recipient: string;
  parentProofId: string | null; codeHash: string; attempts: number; verified: boolean;
  completed: { status: true; operationId: string; action: string } | null;
  requestDigest?: string;
};
type Row = { id: string; value: string; expiresAt: Date };
const TTL = 300_000;
const COOLDOWN = 60_000;
const prefix = "user-security:";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizeContactEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /(?:^|\.)(?:phone\.zzsh|anonymized)\.invalid$/i.test(email.split("@")[1] ?? "")) return null;
  return email;
}

export async function buildUserSecurityPlugin(options: { pool: Pool; outbox?: Map<string, UserSecurityDelivery>; localMock: boolean }) {
  const { APIError, createAuthEndpoint, getSessionFromCtx } = await import("better-auth/api");
  const { setSessionCookie, deleteSessionCookie } = await import("better-auth/cookies");
  type Context = Parameters<typeof setSessionCookie>[0];
  function reject(status: "BAD_REQUEST" | "CONFLICT" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_IMPLEMENTED", message = "Security operation rejected"): never { throw new APIError(status, { message }); }
  const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
  const purposeSchema = z.enum(["password", "email", "phone", "recovery"]);
  const channelSchema = z.enum(["phone", "email"]);
  const requestId = (ctx: Context) => ctx.headers?.get("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}`;
  const proofId = () => randomUUID().replaceAll("-", "");
  const readProof = async (client: PoolClient, id: string, userId: string, allowCompleted = false) => {
    const row = (await client.query<Row>(`SELECT id,value,"expiresAt" FROM zzsh_auth_user.verification WHERE identifier=$1 AND value::jsonb->>'userId'=$2 FOR UPDATE`, [prefix + id, userId])).rows[0];
    if (!row) reject("BAD_REQUEST", "Invalid or expired proof");
    let data: Proof;
    try { data = JSON.parse(row.value) as Proof; } catch { return reject("BAD_REQUEST"); }
    if (data.version !== 1 || (!allowCompleted || !data.completed) && new Date(row.expiresAt).getTime() <= Date.now()) reject("BAD_REQUEST", "Invalid or expired proof");
    return { row, data };
  };
  const save = (client: PoolClient, row: Row, data: Proof) => client.query(`UPDATE zzsh_auth_user.verification SET value=$2,"updatedAt"=clock_timestamp() WHERE id=$1`, [row.id, JSON.stringify(data)]);
  const subject = async (client: PoolClient, id: string): Promise<Subject> => {
    const row = (await client.query<Omit<Subject, "stamp">>(`SELECT u.id,u.name,u."phoneNumber",u.email,u."emailVerified",u.suspended,s.account_status AS "accountStatus",s.version AS "securityVersion" FROM zzsh_auth_user."user" u LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u`, [id])).rows[0];
    if (!row || row.suspended || row.accountStatus !== "ACTIVE") reject("UNAUTHORIZED", "Session unavailable");
    await client.query(`SELECT id FROM zzsh_auth_user.account WHERE "userId"=$1 AND "providerId"='credential' FOR UPDATE`, [id]);
    // The existing subject revision is the security epoch. Rehashing the same legacy password
    // is transparent and must not invalidate an already verified recovery request.
    return { ...row, stamp: sha(JSON.stringify([row.phoneNumber, row.email, row.emailVerified, row.securityVersion])) };
  };
  const context = async (ctx: Context) => {
    const current = await getSessionFromCtx(ctx);
    if (!current) return reject("UNAUTHORIZED", "Session unavailable");
    return current;
  };
  const lockContext = async (client: PoolClient, ctx: Context) => {
    const current = await context(ctx);
    const user = await subject(client, current.user.id);
    const session = (await client.query<{ id: string; expiresAt: Date }>(`SELECT id,"expiresAt" FROM zzsh_auth_user.session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR UPDATE`, [current.session.id, user.id])).rows[0];
    if (!session) reject("UNAUTHORIZED", "Session unavailable");
    return { user, session };
  };
  const assertBound = (data: Proof, user: Subject, sessionId: string | null, purpose: Purpose) => {
    if (data.userId !== user.id || data.sessionId !== sessionId || data.stamp !== user.stamp || data.purpose !== purpose || !data.verified || data.attempts >= 3) reject("CONFLICT", "Proof or identity changed");
  };
  const endpointOptions = { metadata: { noStore: true } } as const;
  const audit = (client: PoolClient, ctx: Context, userId: string, sessionId: string | null, action: string, details?: Record<string, unknown>) => recordAudit(client, { actorType: "user", actorId: userId, sessionId: sessionId ?? undefined, requestId: requestId(ctx), action, objectType: "user", objectId: userId, outcome: "SUCCESS", details });

  const send = createAuthEndpoint("/security/challenge/send", {
    ...endpointOptions, method: "POST",
    body: z.object({ purpose: purposeSchema, channel: channelSchema, stage: z.enum(["current", "target"]).default("current"), target: z.string().max(254).optional(), contact: z.string().max(254).optional(), proofId: idSchema.optional() }).strict(),
  }, async (ctx) => {
    if (!options.outbox && !options.localMock) reject("NOT_IMPLEMENTED", "Verification delivery unavailable");
    const { purpose, channel, stage } = ctx.body;
    const id = proofId();
    const code = options.localMock ? "888888" : String(randomInt(0, 1_000_000)).padStart(6, "0");
    const now = new Date();
    const delivery = await withTransaction(options.pool, async (client) => {
      let user: Subject | null = null;
      let sessionId: string | null = null;
      let recipient: string | null = null;
      let target: string | null = null;
      let parentProofId: string | null = null;
      let expiresAt = new Date(now.getTime() + TTL);
      if (purpose === "recovery") {
        if (stage !== "current" || ctx.body.target !== undefined || ctx.body.proofId !== undefined) reject("BAD_REQUEST");
        recipient = channel === "phone" ? normalizeMainlandPhone(ctx.body.contact) : normalizeContactEmail(ctx.body.contact);
        if (!recipient) reject("BAD_REQUEST");
        const match = (await client.query<{ id: string }>(channel === "phone"
          ? `SELECT id FROM zzsh_auth_user."user" WHERE "phoneNumber"=$1`
          : `SELECT id FROM zzsh_auth_user."user" WHERE lower(email)=$1 AND "emailVerified"=true`, [recipient])).rows[0];
        if (match) {
          const candidate = await subject(client, match.id).catch((error: unknown) => {
            if (error instanceof APIError && error.status === "UNAUTHORIZED") return null;
            throw error;
          });
          // Recheck the contact after acquiring the subject lock; lookup can race a change.
          if (candidate && (channel === "phone" ? candidate.phoneNumber === recipient : candidate.emailVerified && normalizeContactEmail(candidate.email) === recipient)) user = candidate;
        }
        if (channel === "phone" && await hasLegacyPhoneConflict(client, recipient!)) user = null;
      } else {
        const current = await lockContext(client, ctx);
        user = current.user; sessionId = current.session.id;
        target = purpose === "phone" ? normalizeMainlandPhone(ctx.body.target) : purpose === "email" ? normalizeContactEmail(ctx.body.target) : null;
        if (purpose !== "password" && !target || purpose === "password" && ctx.body.target !== undefined || ctx.body.contact !== undefined) reject("BAD_REQUEST");
        if (stage === "target") {
          if (!ctx.body.proofId || purpose === "password" || channel !== (purpose === "phone" ? "phone" : "email")) reject("BAD_REQUEST");
          const parent = await readProof(client, ctx.body.proofId, user.id);
          assertBound(parent.data, user, sessionId, purpose);
          if (parent.data.stage !== "current" || parent.data.target !== target || parent.data.completed) reject("CONFLICT");
          parentProofId = ctx.body.proofId; recipient = target;
          expiresAt = new Date(Math.min(expiresAt.getTime(), new Date(parent.row.expiresAt).getTime()));
        } else {
          if (ctx.body.proofId) reject("BAD_REQUEST");
          recipient = channel === "phone" ? user.phoneNumber : user.emailVerified ? normalizeContactEmail(user.email) : null;
        }
        if (!recipient) reject("FORBIDDEN", "Verified contact unavailable");
      }
      const sendKey = `user-security-send:${sha(JSON.stringify([user?.id ?? "anonymous", purpose, stage, channel, recipient]))}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [sendKey]);
      const previous = (await client.query<{ createdAt: Date }>(`SELECT "createdAt" FROM zzsh_auth_user.verification WHERE identifier=$1 FOR UPDATE`, [sendKey])).rows[0];
      if (previous && now.getTime() - new Date(previous.createdAt).getTime() < COOLDOWN) {
        ctx.setHeader("Retry-After", String(Math.ceil((COOLDOWN - (now.getTime() - new Date(previous.createdAt).getTime())) / 1000)));
        throw new APIError("TOO_MANY_REQUESTS", { message: "Verification rate limited" });
      }
      // Retain the send clock independently of consumption/exhaustion; revoke old challenges on resend.
      await client.query(`DELETE FROM zzsh_auth_user.verification WHERE identifier=$1 OR CASE WHEN identifier LIKE 'user-security:%' THEN value::jsonb->>'sendKey'=$1 ELSE false END`, [sendKey]);
      await client.query(`INSERT INTO zzsh_auth_user.verification (id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,'{}',$3,$4,$4)`, [proofId(), sendKey, new Date(now.getTime() + COOLDOWN), now]);
      const data: Proof & { sendKey: string } = { version: 1, userId: user?.id ?? null, sessionId, stamp: user?.stamp ?? "", purpose, stage, channel, target, recipient: recipient!, parentProofId, codeHash: sha(id + code), attempts: 0, verified: false, completed: null, sendKey };
      await client.query(`INSERT INTO zzsh_auth_user.verification (id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$5)`, [id, prefix + id, JSON.stringify(data), expiresAt, now]);
      return { data, expiresAt };
    });
    if (delivery.data.userId) options.outbox?.set(id, { code, target: delivery.data.recipient, channel, purpose, sentAt: now.toISOString() });
    return ctx.json({ status: true, challengeId: id, cooldownUntil: new Date(now.getTime() + COOLDOWN).toISOString(), expiresAt: delivery.expiresAt.toISOString() });
  });

  const verify = createAuthEndpoint("/security/challenge/verify", {
    ...endpointOptions, method: "POST", body: z.object({ challengeId: idSchema, code: z.string().regex(/^\d{6}$/) }).strict(),
  }, async (ctx) => {
    const accepted = await withTransaction(options.pool, async (client) => {
      // Find the subject before row lock; all operations acquire user -> credential -> proof.
      const hint = (await client.query<Row>(`SELECT id,value,"expiresAt" FROM zzsh_auth_user.verification WHERE identifier=$1`, [prefix + ctx.body.challengeId])).rows[0];
      if (!hint) return false;
      const hinted = JSON.parse(hint.value) as Proof;
      if (!hinted.userId) return false;
      const current = hinted.purpose === "recovery" ? { user: await subject(client, hinted.userId), session: null } : await lockContext(client, ctx);
      const { row, data } = await readProof(client, ctx.body.challengeId, current.user.id);
      if (data.userId !== current.user.id || data.stamp !== current.user.stamp || data.sessionId !== (current.session?.id ?? null) || data.completed || data.attempts >= 3) return false;
      const incoming = sha(ctx.body.challengeId + ctx.body.code);
      if (!timingSafeEqual(Buffer.from(incoming), Buffer.from(data.codeHash))) {
        data.attempts += 1; await save(client, row, data); return false;
      }
      data.verified = true; await save(client, row, data);
      return true;
    });
    if (!accepted) reject("BAD_REQUEST", "Invalid or expired proof");
    return ctx.json({ status: true, proofId: ctx.body.challengeId });
  });

  const commit = (purpose: Purpose) => createAuthEndpoint(`/security/${purpose === "recovery" ? "recovery/complete" : purpose}`, {
    ...endpointOptions, method: "POST", body: z.object({ proofId: idSchema, targetProofId: idSchema.optional(), newPassword: z.string().min(12).max(128).optional() }).strict(),
  }, async (ctx) => {
    const requestDigest = createHmac("sha256", ctx.context.secret).update(JSON.stringify([purpose, ctx.body.proofId, ctx.body.targetProofId ?? null, ctx.body.newPassword ?? null])).digest("hex");
    const result = await withTransaction(options.pool, async (client) => {
      const hint = (await client.query<Row>(`SELECT id,value,"expiresAt" FROM zzsh_auth_user.verification WHERE identifier=$1`, [prefix + ctx.body.proofId])).rows[0];
      if (!hint) reject("BAD_REQUEST");
      const hinted = JSON.parse(hint.value) as Proof;
      if (!hinted.userId) reject("BAD_REQUEST");
      const current = purpose === "recovery" ? { user: await subject(client, hinted.userId!), session: null } : await lockContext(client, ctx);
      const { row, data } = await readProof(client, ctx.body.proofId, current.user.id, true);
      if (data.userId !== current.user.id || data.sessionId !== (current.session?.id ?? null) || data.purpose !== purpose) reject("CONFLICT");
      if (data.completed) {
        if (data.requestDigest !== requestDigest) reject("CONFLICT", "Completed operation differs from the request");
        return { body: data.completed, authenticated: null, recovered: purpose === "recovery" };
      }
      assertBound(data, current.user, current.session?.id ?? null, purpose);
      if (data.stage !== "current") reject("CONFLICT");
      let targetProof: Awaited<ReturnType<typeof readProof>> | null = null;
      if (purpose === "email" || purpose === "phone") {
        if (!ctx.body.targetProofId || ctx.body.newPassword !== undefined) reject("BAD_REQUEST");
        targetProof = await readProof(client, ctx.body.targetProofId!, current.user.id);
        assertBound(targetProof.data, current.user, current.session?.id ?? null, purpose);
        if (targetProof.data.stage !== "target" || targetProof.data.parentProofId !== ctx.body.proofId || targetProof.data.target !== data.target || targetProof.data.recipient !== data.target || targetProof.data.completed) reject("CONFLICT");
        const occupied = await client.query(purpose === "phone" ? `SELECT id FROM zzsh_auth_user."user" WHERE "phoneNumber"=$1 AND id<>$2` : `SELECT id FROM zzsh_auth_user."user" WHERE lower(email)=$1 AND id<>$2`, [data.target, current.user.id]);
        if (occupied.rowCount) reject("CONFLICT", "Contact already in use");
        if (purpose === "phone" && await hasLegacyPhoneConflict(client, data.target!)) reject("CONFLICT", "Account association requires review");
      } else if (!ctx.body.newPassword || ctx.body.targetProofId) reject("BAD_REQUEST");
      await setAuditContext(client, "user", current.user.id, current.session?.id, requestId(ctx));
      if (purpose === "password" || purpose === "recovery") {
        const hash = await ctx.context.password.hash(ctx.body.newPassword!);
        const existing = (await client.query(`SELECT id FROM zzsh_auth_user.account WHERE "userId"=$1 AND "providerId"='credential' FOR UPDATE`, [current.user.id])).rows[0];
        if (existing) await client.query(`UPDATE zzsh_auth_user.account SET password=$2,"legacyPasswordMd5"=NULL,"legacyPasswordSalt"=NULL,"legacyPasswordVersion"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1`, [existing.id, hash]);
        else await client.query(`INSERT INTO zzsh_auth_user.account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,'credential',$2,$3,clock_timestamp(),clock_timestamp())`, ["account_" + proofId(), current.user.id, hash]);
      } else if (purpose === "phone") {
        // Internal addresses follow the stable subject, so releasing a number permits a new holder to register.
        await client.query(`UPDATE zzsh_auth_user."user" SET "phoneNumber"=$2,"phoneNumberVerified"=true,email=$3,"updatedAt"=clock_timestamp() WHERE id=$1`, [current.user.id, data.target, normalizeContactEmail(current.user.email) ? current.user.email : `user-${sha(current.user.id)}@phone.zzsh.invalid`]);
      } else {
        await client.query(`UPDATE zzsh_auth_user."user" SET email=$2,"emailVerified"=true,"updatedAt"=clock_timestamp() WHERE id=$1`, [current.user.id, data.target]);
      }
      await client.query(`DELETE FROM zzsh_auth_user.session WHERE "userId"=$1`, [current.user.id]);
      await client.query(`UPDATE zzsh_iam.user_identity_state SET version=version+1,updated_at=clock_timestamp() WHERE user_id=$1`, [current.user.id]);
      const authenticated = current.session ? await createTransactionalUserSession(client, ctx, current.user.id, new Date(current.session.expiresAt)) : null;
      const body = { status: true as const, operationId: ctx.body.proofId, action: purpose };
      data.completed = body;
      data.requestDigest = requestDigest;
      // Preserve this exact receipt, invalidate all other pending proof/challenges for the subject.
      await client.query(`DELETE FROM zzsh_auth_user.verification WHERE CASE WHEN identifier LIKE 'user-security:%' THEN value::jsonb->>'userId'=$1 ELSE false END AND id<>$2`, [current.user.id, row.id]);
      await save(client, row, data);
      await audit(client, ctx, current.user.id, current.session?.id ?? null, `user.security.${purpose}.changed`, { operationId: body.operationId });
      return { body, authenticated, recovered: purpose === "recovery" };
    }).catch((error: unknown) => { if (error && typeof error === "object" && "code" in error && error.code === "23505") reject("CONFLICT", "Contact already in use"); throw error; });
    if (result.authenticated) await setSessionCookie(ctx, result.authenticated, false, { maxAge: Math.max(0, Math.floor((new Date(result.authenticated.session.expiresAt).getTime() - Date.now()) / 1000)) });
    else if (result.recovered) deleteSessionCookie(ctx);
    return ctx.json(result.body);
  });

  const overview = createAuthEndpoint("/security/overview", { ...endpointOptions, method: "GET" }, async (ctx) => {
    const result = await withTransaction(options.pool, async (client) => {
      const { user } = await lockContext(client, ctx);
      const passwordState = await readUserPasswordState(client, user.id);
      return { userId: user.id, nickname: user.name, phoneNumber: user.phoneNumber, email: user.emailVerified ? normalizeContactEmail(user.email) : null, passwordState };
    });
    return ctx.json(result);
  });
  const nickname = createAuthEndpoint("/profile/nickname", { ...endpointOptions, method: "POST", body: z.object({ nickname: z.string().refine(value => value.trim().length > 0 && [...value].length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)) }).strict() }, async (ctx) => {
    await withTransaction(options.pool, async (client) => { const current = await lockContext(client, ctx); await client.query(`UPDATE zzsh_auth_user."user" SET name=$2,"updatedAt"=clock_timestamp() WHERE id=$1`, [current.user.id, ctx.body.nickname]); await audit(client, ctx, current.user.id, current.session.id, "user.nickname.changed"); });
    return ctx.json({ status: true, nickname: ctx.body.nickname });
  });
  const receipt = createAuthEndpoint("/security/operation", { ...endpointOptions, method: "POST", body: z.object({ operationId: idSchema }).strict() }, async (ctx) => {
    const current = await getSessionFromCtx(ctx);
    const result = await withTransaction(options.pool, async (client) => {
      const hint = (await client.query<Row>(`SELECT id,value,"expiresAt" FROM zzsh_auth_user.verification WHERE identifier=$1`, [prefix + ctx.body.operationId])).rows[0];
      if (!hint) reject("FORBIDDEN");
      const hinted = JSON.parse(hint.value) as Proof;
      if (!hinted.userId || (hinted.purpose === "recovery" ? !hinted.verified : hinted.userId !== current?.user.id)) reject("FORBIDDEN");
      // Join the commit's lock order before declaring that this proof can no longer write.
      // An in-flight accepted commit must finish first and its completed receipt wins.
      await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [hinted.userId]);
      await client.query(`SELECT id FROM zzsh_auth_user.account WHERE "userId"=$1 AND "providerId"='credential' FOR UPDATE`, [hinted.userId]);
      const row = (await client.query<Row>(`SELECT id,value,"expiresAt" FROM zzsh_auth_user.verification WHERE identifier=$1 AND value::jsonb->>'userId'=$2 FOR UPDATE`, [prefix + ctx.body.operationId, hinted.userId])).rows[0];
      const data = row ? JSON.parse(row.value) as Proof : null;
      return { status: data?.completed ? "completed" : row && new Date(row.expiresAt).getTime() <= Date.now() ? "expired" : "unconfirmed", result: data?.completed ?? null, expiresAt: new Date(row?.expiresAt ?? hint.expiresAt).toISOString() };
    });
    return ctx.json(result);
  });
  const sessions = createAuthEndpoint("/security/sessions", { ...endpointOptions, method: "GET" }, async (ctx) => {
    const current = await context(ctx);
    const result = await options.pool.query<{ id: string; createdAt: Date; expiresAt: Date; userAgent: string | null }>(`SELECT id,"createdAt","expiresAt","userAgent" FROM zzsh_auth_user.session WHERE "userId"=$1 AND "expiresAt">clock_timestamp() ORDER BY "createdAt" DESC,id`, [current.user.id]);
    return ctx.json({ sessions: result.rows.map(row => ({ id: row.id, isCurrent: row.id === current.session.id, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), userAgent: row.userAgent?.slice(0, 512) || null })) });
  });
  const revoke = (scope: "one" | "others" | "all") => createAuthEndpoint(`/security/sessions/${scope === "one" ? "revoke" : "revoke-" + scope}`, { ...endpointOptions, method: "POST", body: z.object({ sessionId: z.string().min(1).max(128).optional() }).strict() }, async (ctx) => {
    const currentRevoked = await withTransaction(options.pool, async (client) => {
      const current = await lockContext(client, ctx);
      if (scope === "one") {
        if (!ctx.body.sessionId) reject("BAD_REQUEST");
        const target = await client.query(`SELECT id FROM zzsh_auth_user.session WHERE id=$1 AND "userId"=$2`, [ctx.body.sessionId, current.user.id]);
        if (!target.rowCount) reject("FORBIDDEN");
      } else if (ctx.body.sessionId) reject("BAD_REQUEST");
      await client.query(`DELETE FROM zzsh_auth_user.session WHERE "userId"=$1${scope === "one" ? " AND id=$2" : scope === "others" ? " AND id<>$2" : ""}`, scope === "all" ? [current.user.id] : [current.user.id, scope === "one" ? ctx.body.sessionId : current.session.id]);
      await audit(client, ctx, current.user.id, current.session.id, "user.sessions.revoked", { scope });
      return scope === "all" || scope === "one" && ctx.body.sessionId === current.session.id;
    });
    if (currentRevoked) deleteSessionCookie(ctx);
    return ctx.json({ status: true, currentRevoked });
  });
  return {
    id: "user-account-security", endpoints: { userSecuritySend: send, userSecurityVerify: verify, userSecurityPassword: commit("password"), userSecurityEmail: commit("email"), userSecurityPhone: commit("phone"), userSecurityRecovery: commit("recovery"), userSecurityOverview: overview, userNickname: nickname, userSecurityReceipt: receipt, userSecuritySessions: sessions, userSessionRevoke: revoke("one"), userSessionsRevokeOthers: revoke("others"), userSessionsRevokeAll: revoke("all") },
    rateLimit: [{ window: 60, max: 12, pathMatcher: (path: string) => path.startsWith("/security/") && !["/security/overview", "/security/sessions", "/security/operation"].includes(path) }],
  };
}
