import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { ConfigurationError } from "../config/config";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import { ADMIN_CLIENT_IP_FORWARD_HEADER, DEFAULT_ADMIN_CLIENT_IP_CONFIG, type AdminClientIpConfig } from "./admin-client-ip";

/**
 * 管理员认证防爆破（仅管理员 realm）：Postgres 共享滑动窗口 + 渐进锁定 + 自托管 ALTCHA。
 * 任一存储/校验异常一律拒绝（fail closed）；用户 realm 不经过本模块。
 */
export type AdminAuthScope = "sign-in" | "two-factor" | "step-up" | "recovery";

export const ADMIN_BRUTE_FORCE_POLICY = {
  windowSeconds: 15 * 60,
  lockThreshold: 5,
  captchaThreshold: 3,
  /** 第 n 次锁定的时长（秒）；超过末项按末项封顶（1 小时）。 */
  lockLadderSeconds: [60, 300, 1800, 3600] as const,
  /** 距上次锁定超过该时长后锁定等级归零。 */
  levelDecaySeconds: 24 * 60 * 60,
  captchaTtlSeconds: 5 * 60,
  captchaCost: 5000,
} as const;

export const ADMIN_GENERIC_CREDENTIAL_ERROR = "账号或密码错误";
export const ADMIN_LOCKED_MESSAGE = "尝试次数过多，请稍后再试";
export const ADMIN_CAPTCHA_REQUIRED_REASON = "CAPTCHA_REQUIRED";

export function lockSecondsForLevel(level: number): number {
  const ladder = ADMIN_BRUTE_FORCE_POLICY.lockLadderSeconds;
  return ladder[Math.min(Math.max(level, 1), ladder.length) - 1]!;
}

/** 主体键只保存摘要：不落库原始用户名/IP。 */
export function adminAuthSubject(kind: "account" | "ip" | "challenge", value: string): string {
  return `${kind}:${createHash("sha256").update(`${kind}\u0000${value}`).digest("hex").slice(0, 40)}`;
}

export type AdminAuthStatus = { failures: number; lockedUntil?: Date };
export type AdminAuthFailureResult = AdminAuthStatus & { newlyLocked: boolean };

export interface AdminAuthThrottleStore {
  status(scope: AdminAuthScope, subjects: readonly string[]): Promise<AdminAuthStatus>;
  recordFailure(scope: AdminAuthScope, subjects: readonly string[], audit: { requestId: string }): Promise<AdminAuthFailureResult>;
  clear(scope: AdminAuthScope, subjects: readonly string[]): Promise<void>;
  /** 一次性消费验证码签名（防重放）；已用过返回 false。 */
  consumeCaptcha(signature: string, expiresAt: Date): Promise<boolean>;
}

function merge(results: AdminAuthFailureResult[]): AdminAuthFailureResult {
  let lockedUntil: Date | undefined;
  for (const result of results) if (result.lockedUntil && (!lockedUntil || result.lockedUntil > lockedUntil)) lockedUntil = result.lockedUntil;
  return {
    failures: Math.max(0, ...results.map((result) => result.failures)),
    newlyLocked: results.some((result) => result.newlyLocked),
    ...(lockedUntil ? { lockedUntil } : {}),
  };
}

async function recordThrottleAudit(client: PoolClient, event: Parameters<typeof recordAudit>[1]): Promise<void> {
  await client.query("SAVEPOINT admin_auth_audit");
  try { await recordAudit(client, event); }
  catch {
    await client.query("ROLLBACK TO SAVEPOINT admin_auth_audit");
    try { console.warn(JSON.stringify({ event: "admin.auth.audit.unavailable", action: event.action })); } catch { /* counting remains authoritative */ }
  }
  await client.query("RELEASE SAVEPOINT admin_auth_audit");
}

export function createPostgresAdminAuthThrottle(pool: Pool): AdminAuthThrottleStore {
  const policy = ADMIN_BRUTE_FORCE_POLICY;
  return {
    async status(scope, subjects) {
      if (subjects.length === 0) return { failures: 0 };
      const result = await pool.query<{ failures: number; lockedUntil: Date | null }>(
        `SELECT
           (SELECT COALESCE(MAX(c), 0)::int FROM (
              SELECT COUNT(*) AS c FROM "zzsh_iam"."admin_auth_failure"
               WHERE "scope" = $1 AND "subject" = ANY($2::text[])
                 AND "occurred_at" > clock_timestamp() - make_interval(secs => $3)
               GROUP BY "subject") counts) AS "failures",
           (SELECT MAX("locked_until") FROM "zzsh_iam"."admin_auth_lockout"
             WHERE "scope" = $1 AND "subject" = ANY($2::text[]) AND "locked_until" > clock_timestamp()) AS "lockedUntil"`,
        [scope, subjects, policy.windowSeconds],
      );
      const row = result.rows[0];
      return { failures: row?.failures ?? 0, ...(row?.lockedUntil ? { lockedUntil: new Date(row.lockedUntil) } : {}) };
    },
    async recordFailure(scope, subjects, audit) {
      return withTransaction(pool, async (client) => {
        await setAuditContext(client, "system", undefined, undefined, audit.requestId);
        const results: AdminAuthFailureResult[] = [];
        for (const subject of [...new Set(subjects)].sort()) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`admin-auth:${scope}:${subject}`]);
          await client.query(
            `DELETE FROM "zzsh_iam"."admin_auth_failure" WHERE "scope" = $1 AND "subject" = $2
               AND "occurred_at" <= clock_timestamp() - make_interval(secs => $3)`,
            [scope, subject, policy.windowSeconds],
          );
          await client.query(`INSERT INTO "zzsh_iam"."admin_auth_failure" ("scope", "subject") VALUES ($1, $2)`, [scope, subject]);
          const count = await client.query<{ failures: number }>(
            `SELECT COUNT(*)::int AS "failures" FROM "zzsh_iam"."admin_auth_failure" WHERE "scope" = $1 AND "subject" = $2`,
            [scope, subject],
          );
          const failures = count.rows[0]?.failures ?? 0;
          if (failures < policy.lockThreshold) {
            results.push({ failures, newlyLocked: false });
            continue;
          }
          const lock = await client.query<{ level: number; lockedUntil: Date }>(
            `INSERT INTO "zzsh_iam"."admin_auth_lockout" AS l ("scope", "subject", "level", "locked_until", "updated_at")
             VALUES ($1, $2, 1, clock_timestamp() + make_interval(secs => $3), clock_timestamp())
             ON CONFLICT ("scope", "subject") DO UPDATE SET
               "level" = LEAST(CASE WHEN l."updated_at" < clock_timestamp() - make_interval(secs => $4) THEN 0 ELSE l."level" END + 1, $5),
               "updated_at" = clock_timestamp(),
               "locked_until" = clock_timestamp() + make_interval(secs => (($6::int[])[LEAST(CASE WHEN l."updated_at" < clock_timestamp() - make_interval(secs => $4) THEN 0 ELSE l."level" END + 1, $5)]))
             RETURNING "level", "locked_until" AS "lockedUntil"`,
            [scope, subject, policy.lockLadderSeconds[0], policy.levelDecaySeconds, policy.lockLadderSeconds.length, [...policy.lockLadderSeconds]],
          );
          await client.query(`DELETE FROM "zzsh_iam"."admin_auth_failure" WHERE "scope" = $1 AND "subject" = $2`, [scope, subject]);
          const row = lock.rows[0]!;
          await recordThrottleAudit(client, {
            actorType: "system", action: "admin.auth.lockout", objectType: "admin_auth_subject", objectId: subject,
            outcome: "FAILURE", requestId: audit.requestId, reason: "TOO_MANY_FAILURES",
            details: { scope, level: row.level, lockSeconds: lockSecondsForLevel(row.level), lockedUntil: new Date(row.lockedUntil).toISOString() },
          });
          results.push({ failures, newlyLocked: true, lockedUntil: new Date(row.lockedUntil) });
        }
        const merged = merge(results);
        await recordThrottleAudit(client, {
          actorType: "system", action: "admin.auth.failure", objectType: "admin_auth_subject", objectId: subjects[0],
          outcome: "FAILURE", requestId: audit.requestId,
          details: { scope, subjectKinds: subjects.map((subject) => subject.split(":", 1)[0]), failures: merged.failures, locked: merged.newlyLocked },
        });
        return merged;
      });
    },
    async clear(scope, subjects) {
      if (subjects.length === 0) return;
      await pool.query(`DELETE FROM "zzsh_iam"."admin_auth_failure" WHERE "scope" = $1 AND "subject" = ANY($2::text[])`, [scope, subjects]);
    },
    async consumeCaptcha(signature, expiresAt) {
      await pool.query(`DELETE FROM "zzsh_iam"."admin_auth_captcha_used" WHERE "expires_at" < clock_timestamp()`);
      const inserted = await pool.query(
        `INSERT INTO "zzsh_iam"."admin_auth_captcha_used" ("signature", "expires_at") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [signature, expiresAt],
      );
      return inserted.rowCount === 1;
    },
  };
}

/** 进程内实现：仅供离线测试；语义与 Postgres 实现一致。 */
export function createMemoryAdminAuthThrottle(now: () => number = Date.now): AdminAuthThrottleStore & { audits: Array<{ action: string; details: Record<string, unknown> }> } {
  const policy = ADMIN_BRUTE_FORCE_POLICY;
  const failures = new Map<string, number[]>();
  const locks = new Map<string, { level: number; lockedUntil: number; updatedAt: number }>();
  const used = new Map<string, number>();
  const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  const live = (key: string) => (failures.get(key) ?? []).filter((at) => at > now() - policy.windowSeconds * 1000);
  return {
    audits,
    async status(scope, subjects) {
      let count = 0; let lockedUntil: number | undefined;
      for (const subject of subjects) {
        const key = `${scope}|${subject}`;
        count = Math.max(count, live(key).length);
        const lock = locks.get(key);
        if (lock && lock.lockedUntil > now() && (!lockedUntil || lock.lockedUntil > lockedUntil)) lockedUntil = lock.lockedUntil;
      }
      return { failures: count, ...(lockedUntil ? { lockedUntil: new Date(lockedUntil) } : {}) };
    },
    async recordFailure(scope, subjects) {
      const results: AdminAuthFailureResult[] = [];
      for (const subject of new Set(subjects)) {
        const key = `${scope}|${subject}`;
        const events = [...live(key), now()];
        failures.set(key, events);
        if (events.length < policy.lockThreshold) { results.push({ failures: events.length, newlyLocked: false }); continue; }
        const previous = locks.get(key);
        const base = previous && previous.updatedAt >= now() - policy.levelDecaySeconds * 1000 ? previous.level : 0;
        const level = Math.min(base + 1, policy.lockLadderSeconds.length);
        const lockedUntil = now() + lockSecondsForLevel(level) * 1000;
        locks.set(key, { level, lockedUntil, updatedAt: now() });
        failures.delete(key);
        audits.push({ action: "admin.auth.lockout", details: { scope, level, lockSeconds: lockSecondsForLevel(level) } });
        results.push({ failures: events.length, newlyLocked: true, lockedUntil: new Date(lockedUntil) });
      }
      const merged = merge(results);
      audits.push({ action: "admin.auth.failure", details: { scope, failures: merged.failures, locked: merged.newlyLocked } });
      return merged;
    },
    async clear(scope, subjects) { for (const subject of subjects) failures.delete(`${scope}|${subject}`); },
    async consumeCaptcha(signature, expiresAt) {
      for (const [key, at] of used) if (at < now()) used.delete(key);
      if (used.has(signature)) return false;
      used.set(signature, expiresAt.getTime());
      return true;
    },
  };
}

// ---- ALTCHA（altcha-lib v2，MIT，自托管；无外部调用） ----
type AltchaChallenge = { parameters: { expiresAt?: number } & Record<string, unknown>; signature?: string };
type AltchaLib = {
  createChallenge: (options: Record<string, unknown>) => Promise<AltchaChallenge>;
  verifySolution: (options: Record<string, unknown>) => Promise<{ verified: boolean; expired: boolean }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const altcha = require("altcha-lib") as AltchaLib;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pbkdf2 = require("altcha-lib/algorithms/pbkdf2") as { deriveKey: unknown };

export type AdminCaptcha = {
  challenge(): Promise<AltchaChallenge>;
  /** payload 为 widget 提交的 base64 JSON；校验签名、解答、有效期并一次性消费。 */
  verify(payload: unknown): Promise<boolean>;
};

export function createAdminCaptcha(hmacKey: string, store: AdminAuthThrottleStore, cost: number = ADMIN_BRUTE_FORCE_POLICY.captchaCost): AdminCaptcha {
  return {
    challenge: () => altcha.createChallenge({
      algorithm: "PBKDF2/SHA-256", cost, deriveKey: pbkdf2.deriveKey,
      expiresAt: new Date(Date.now() + ADMIN_BRUTE_FORCE_POLICY.captchaTtlSeconds * 1000),
      hmacSignatureSecret: hmacKey,
    }),
    async verify(payload) {
      if (typeof payload !== "string" || payload.length === 0 || payload.length > 4096) return false;
      try {
        const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { challenge?: AltchaChallenge; solution?: unknown };
        if (!decoded?.challenge?.signature || !decoded.solution || typeof decoded.challenge.parameters?.expiresAt !== "number") return false;
        const result = await altcha.verifySolution({ challenge: decoded.challenge, solution: decoded.solution, deriveKey: pbkdf2.deriveKey, hmacSignatureSecret: hmacKey });
        if (!result.verified || result.expired) return false;
        return await store.consumeCaptcha(decoded.challenge.signature, new Date(decoded.challenge.parameters.expiresAt * 1000));
      } catch {
        return false;
      }
    },
  };
}

/** ADMIN_ALTCHA_HMAC_KEY：生产必填（≥32 字符）；非生产缺省时启动时随机生成，仅存内存、不打印。 */
export function readAdminAltchaHmacKey(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.ADMIN_ALTCHA_HMAC_KEY;
  if (value === undefined || value === "") {
    if (env.NODE_ENV === "production") throw new ConfigurationError("ADMIN_ALTCHA_HMAC_KEY is required in production");
    return undefined;
  }
  if (value.length < 32) throw new ConfigurationError("ADMIN_ALTCHA_HMAC_KEY must be at least 32 characters");
  return value;
}

export function generateDevAltchaHmacKey(): string {
  return randomBytes(32).toString("base64url");
}

// ---- 统一门禁 ----
export type AdminBruteForce = { store: AdminAuthThrottleStore; captcha: AdminCaptcha; clientIp: AdminClientIpConfig; twoFactorCookieName: string };

export function createAdminBruteForce(options: { pool: Pool; hmacKey?: string; clientIp?: AdminClientIpConfig; store?: AdminAuthThrottleStore; secureCookies?: boolean }): AdminBruteForce {
  const store = options.store ?? createPostgresAdminAuthThrottle(options.pool);
  return { store, captcha: createAdminCaptcha(options.hmacKey ?? generateDevAltchaHmacKey(), store), clientIp: options.clientIp ?? DEFAULT_ADMIN_CLIENT_IP_CONFIG,
    twoFactorCookieName: `${options.secureCookies ? "__Secure-" : ""}zzsh_admin.two_factor` };
}

export function adminAuthSubjects(account: string | undefined, ip: string | undefined): string[] {
  return [
    ...(account ? [adminAuthSubject("account", account.trim().toLowerCase())] : []),
    ...(ip ? [adminAuthSubject("ip", ip)] : []),
  ];
}

function tooMany(): SecurityApiError {
  return new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, ADMIN_LOCKED_MESSAGE);
}

export function captchaRequiredError(): SecurityApiError {
  return Object.assign(new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "请先完成人机验证"), { reason: ADMIN_CAPTCHA_REQUIRED_REASON });
}

/** 门禁：锁定中 → 429；失败数达阈值且需验证码时校验 ALTCHA；存储异常 → 429（fail closed）。 */
export async function gateAdminAuth(bf: AdminBruteForce, scope: AdminAuthScope, subjects: readonly string[], captcha: { required: boolean; payload: unknown }): Promise<AdminAuthStatus> {
  let status: AdminAuthStatus;
  try { status = await bf.store.status(scope, subjects); } catch { throw tooMany(); }
  if (status.lockedUntil) throw tooMany();
  if (captcha.required && status.failures >= ADMIN_BRUTE_FORCE_POLICY.captchaThreshold && !await bf.captcha.verify(captcha.payload)) {
    throw captchaRequiredError();
  }
  return status;
}

export async function recordAdminAuthFailure(bf: AdminBruteForce, scope: AdminAuthScope, subjects: readonly string[], requestId: string): Promise<AdminAuthFailureResult | undefined> {
  try { return await bf.store.recordFailure(scope, subjects, { requestId }); } catch { return undefined; }
}

export async function clearAdminAuthFailures(bf: AdminBruteForce, scope: AdminAuthScope, subjects: readonly string[]): Promise<void> {
  try { await bf.store.clear(scope, subjects); } catch { /* 失败计数自然过期；不影响已成功的认证 */ }
}

// ---- better-auth 管理员 Web handler 包装（BFF 与直连 /api/auth/admin 共用） ----
const SIGN_IN_PATHS = new Set(["/sign-in/email", "/sign-in/username"]);
const TWO_FACTOR_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const ADMIN_BASE = "/api/auth/admin";

function twoFactorCookie(request: Request, cookieName: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName) return rest.join("=");
  }
  return undefined;
}

function jsonError(status: number, code: string, message: string, requestId: string, extra: Record<string, unknown> = {}, reason?: string): Response {
  return new Response(JSON.stringify({ code, message, ...extra, error: { code, message, requestId, ...(reason ? { reason } : {}) } }), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function withAdminBruteForce(handler: (request: Request) => Promise<Response>, bf: AdminBruteForce): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(ADMIN_BASE) ? url.pathname.slice(ADMIN_BASE.length) : url.pathname;
    const signIn = SIGN_IN_PATHS.has(path);
    const twoFactor = TWO_FACTOR_PATHS.has(path);
    if (request.method !== "POST" || (!signIn && !twoFactor)) return handler(request);
    const requestId = request.headers.get("x-request-id") ?? "unknown";
    const ip = request.headers.get(ADMIN_CLIENT_IP_FORWARD_HEADER) ?? undefined;
    const headers = new Headers(request.headers);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await request.text() || "{}");
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return jsonError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid", requestId);
    }
    const captchaPayload = body.altcha;
    delete body.altcha;
    const account = signIn
      ? (path === "/sign-in/username" ? (typeof body.username === "string" ? body.username : undefined) : (typeof body.email === "string" ? body.email : undefined))
      : twoFactorCookie(request, bf.twoFactorCookieName);
    const scope: AdminAuthScope = signIn ? "sign-in" : "two-factor";
    const subjects = adminAuthSubjects(account ? `${signIn ? "id" : "challenge"}:${account}` : undefined, ip);
    try {
      await gateAdminAuth(bf, scope, subjects, { required: signIn, payload: captchaPayload });
    } catch (error) {
      const e = error as SecurityApiError & { reason?: string };
      return jsonError(e.status, e.code, e.message, requestId, e.reason ? { captchaRequired: true } : {}, e.reason);
    }
    const upstream = await handler(new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) }));
    if (upstream.status === 401 || upstream.status === 403 && !signIn) {
      const result = await recordAdminAuthFailure(bf, scope, subjects, requestId);
      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete("content-length");
      if (!result || result.lockedUntil) return jsonError(429, API_V1_ERROR_CODES.RATE_LIMITED, ADMIN_LOCKED_MESSAGE, requestId);
      const captchaRequired = signIn && result.failures >= ADMIN_BRUTE_FORCE_POLICY.captchaThreshold;
      let upstreamCode = "INVALID_CREDENTIALS";
      try { upstreamCode = String((JSON.parse(await upstream.text()) as { code?: unknown }).code ?? upstreamCode); } catch { /* keep generic */ }
      const message = signIn ? ADMIN_GENERIC_CREDENTIAL_ERROR : "验证码错误";
      return new Response(JSON.stringify({ code: upstreamCode, message, ...(captchaRequired ? { captchaRequired: true } : {}),
        error: { code: API_V1_ERROR_CODES.UNAUTHENTICATED, message, requestId, ...(captchaRequired ? { reason: ADMIN_CAPTCHA_REQUIRED_REASON } : {}) } }),
      { status: 401, headers: outHeaders });
    }
    if (upstream.ok) await clearAdminAuthFailures(bf, scope, subjects);
    return upstream;
  };
}
