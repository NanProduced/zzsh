import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { ConfigurationError, readSecret } from "../config/config";
import { normalizeMainlandPhone } from "./phone-number";
import { throttleClientIp, USER_CLIENT_IP_FORWARD_HEADER } from "./user-client-ip";

/**
 * 待 Owner 确认的建议值，不是已发布政策。
 * 硬限制只落在真实 IP 与账号+IP；账号维度只升级为本地验证。
 * 短信验证码错误不进入密码计数，也不改 account_status。
 */
export const USER_THROTTLE_PROPOSAL = {
  signInWindowSeconds: 15 * 60,
  accountCaptchaAfter: 3,
  pairMax: 10,
  ipMax: 30,
  smsPhonePerDay: 10,
  smsIpPerMinute: 5,
  smsIpPerDay: 50,
  smsIpCaptchaAfter: 3,
  daySeconds: 24 * 60 * 60,
  captchaTtlSeconds: 5 * 60,
  captchaCost: 1000,
} as const;

export type UserThrottlePolicy = { [K in keyof typeof USER_THROTTLE_PROPOSAL]: number };
export const USER_REALM = "user";

type Kind = "reserved" | "failure" | "sent" | "unknown";
type Row = { purpose: string; subject: string; kind: Kind; ticket: string; at: number };
type Challenge = { parameters: Record<string, unknown> & { expiresAt?: number }; signature?: string };
type Decision =
  | { decision: "allow"; ticket?: string }
  | { decision: "limited"; retryAfter: number }
  | { decision: "captcha"; challenge: Challenge | null };

export class ThrottleDependencyError extends Error {
  constructor() { super("throttle dependency unavailable"); this.name = "ThrottleDependencyError"; }
}

export function readUserThrottleHmacKey(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
  secrets: { userSecret?: string; adminSecret?: string } = {},
): string | undefined {
  const present = env.USER_AUTH_THROTTLE_HMAC_KEY !== undefined || env.USER_AUTH_THROTTLE_HMAC_KEY_FILE !== undefined;
  if (!present) {
    if (env.NODE_ENV === "production" || env.USER_AUTH_THROTTLE_STORE?.trim() === "postgres") throw new ConfigurationError("USER_AUTH_THROTTLE_HMAC_KEY is required for production or postgres storage");
    return undefined;
  }
  const value = readSecret(env, "USER_AUTH_THROTTLE_HMAC_KEY", "USER_AUTH_THROTTLE_HMAC_KEY_FILE", workingDirectory);
  if (value.length < 32) throw new ConfigurationError("USER_AUTH_THROTTLE_HMAC_KEY must be at least 32 characters");
  if (value === secrets.userSecret || value === secrets.adminSecret) {
    throw new ConfigurationError("USER_AUTH_THROTTLE_HMAC_KEY must be independent of auth secrets");
  }
  return value;
}

export function throttleDigest(hmacKey: string, realm: string, kind: string, value: string): string {
  return createHmac("sha256", hmacKey).update(`${realm}\0${kind}\0${value}`).digest("hex");
}

function captchaKey(hmacKey: string, realm: string): string {
  return createHmac("sha256", hmacKey).update(`user-captcha-v1\0${realm}`).digest("base64url");
}

export function signInSubjects(hmacKey: string, phone: string, ip: string | undefined, realm = USER_REALM) {
  const account = throttleDigest(hmacKey, realm, "phone", phone);
  const clientIp = throttleClientIp(ip);
  if (!clientIp) return { account };
  return {
    account,
    pair: throttleDigest(hmacKey, realm, "pair", `${phone}\0${clientIp}`),
    ip: throttleDigest(hmacKey, realm, "ip", clientIp),
  };
}

const COUNTED = new Set<Kind>(["reserved", "failure", "sent", "unknown"]);

function inWindow(rows: readonly Row[], purpose: string, subject: string | undefined, since: number, kinds = COUNTED): Row[] {
  if (!subject) return [];
  return rows.filter((row) => row.purpose === purpose && row.subject === subject && row.at > since && kinds.has(row.kind));
}

function retryAfter(rows: readonly Row[], now: number, windowSeconds: number): number {
  const oldest = rows.reduce((min, row) => Math.min(min, row.at), now);
  return Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000));
}

export function decideSignIn(rows: readonly Row[], subjects: { account: string; pair?: string; ip?: string }, captchaOk: boolean, now: number, policy: UserThrottlePolicy): Decision {
  const since = now - policy.signInWindowSeconds * 1000;
  const pairRows = inWindow(rows, "sign-in", subjects.pair, since);
  const ipRows = inWindow(rows, "sign-in", subjects.ip, since);
  if (subjects.pair && pairRows.length >= policy.pairMax) return { decision: "limited", retryAfter: retryAfter(pairRows, now, policy.signInWindowSeconds) };
  if (subjects.ip && ipRows.length >= policy.ipMax) return { decision: "limited", retryAfter: retryAfter(ipRows, now, policy.signInWindowSeconds) };
  const accountFailures = inWindow(rows, "sign-in", subjects.account, since, new Set(["failure"]));
  if (accountFailures.length >= policy.accountCaptchaAfter && !captchaOk) return { decision: "captcha", challenge: null };
  const ticket = subjects.pair || subjects.ip ? randomBytes(16).toString("hex") : undefined;
  return { decision: "allow", ...(ticket ? { ticket } : {}) };
}

export function decideSms(rows: readonly Row[], input: { phone?: string; ip?: string }, captchaOk: boolean, now: number, policy: UserThrottlePolicy): Decision {
  const day = now - policy.daySeconds * 1000;
  const minute = now - 60_000;
  const phoneRows = inWindow(rows, "sms-phone", input.phone, day);
  if (input.phone && phoneRows.length >= policy.smsPhonePerDay) return { decision: "limited", retryAfter: retryAfter(phoneRows, now, policy.daySeconds) };
  const ipDay = inWindow(rows, "sms-ip", input.ip, day);
  const ipMinute = inWindow(rows, "sms-ip", input.ip, minute);
  if (input.ip && ipMinute.length >= policy.smsIpPerMinute) return { decision: "limited", retryAfter: retryAfter(ipMinute, now, 60) };
  if (input.ip && ipDay.length >= policy.smsIpPerDay) return { decision: "limited", retryAfter: retryAfter(ipDay, now, policy.daySeconds) };
  if (input.ip && ipDay.length >= policy.smsIpCaptchaAfter && !captchaOk) return { decision: "captcha", challenge: null };
  return { decision: "allow", ticket: randomBytes(16).toString("hex") };
}

type AuditEvent = { action: string; purpose: string; subject: string; outcome: string };

function auditFallback(logs: Array<{ action: string; subjectPrefix: string }>, event: AuditEvent): void {
  const record = { action: event.action, subjectPrefix: event.subject.slice(0, 8) };
  logs.push(record);
  if (logs.length > 128) logs.splice(0, logs.length - 128);
  try { console.warn(JSON.stringify({ event: "user.auth.audit_fallback", ...record, purpose: event.purpose })); } catch { /* logging must not discard the security counter */ }
}

type AltchaLib = {
  createChallenge(options: Record<string, unknown>): Promise<Challenge>;
  verifySolution(options: Record<string, unknown>): Promise<{ verified: boolean; expired: boolean }>;
};

function altchaLib(): AltchaLib {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const altcha = require("altcha-lib") as AltchaLib;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pbkdf2 = require("altcha-lib/algorithms/pbkdf2") as { deriveKey: unknown };
  return {
    createChallenge: (options) => altcha.createChallenge({ ...options, deriveKey: pbkdf2.deriveKey }),
    verifySolution: (options) => altcha.verifySolution({ ...options, deriveKey: pbkdf2.deriveKey }),
  };
}

export type UserAuthThrottle = {
  readonly realm: string;
  readonly fallbackLogs: Array<{ action: string; subjectPrefix: string }>;
  challenge(): Promise<Challenge>;
  admitSignIn(subjects: { account: string; pair?: string; ip?: string }, captchaPayload: unknown): Promise<Decision>;
  settleSignIn(input: { ticket?: string; outcome: "credential" | "success" | "ignore"; account: string; pair?: string; ip?: string }): Promise<{ captchaNow: boolean }>;
  admitSmsIp(ip: string | undefined, captchaPayload: unknown): Promise<Decision>;
  settleSmsIp(ticket: string | undefined, outcome: "sent" | "release" | "unknown"): Promise<void>;
  holdSmsPhone(client: PoolClient | null, phone: string): Promise<Decision & { durable: boolean }>;
  releaseSmsPhone(ticket: string): Promise<void>;
};

function ticket(): string { return randomBytes(16).toString("hex"); }

export function createMemoryUserAuthThrottle(options: {
  hmacKey: string;
  realm?: string;
  policy?: Partial<UserThrottlePolicy>;
  now?: () => number;
  audit?: (event: AuditEvent) => Promise<void> | void;
  captchaCost?: number;
} = { hmacKey: "memory-throttle-key-not-a-deployment-secret" }): UserAuthThrottle {
  const realm = options.realm ?? USER_REALM;
  const policy: UserThrottlePolicy = { ...USER_THROTTLE_PROPOSAL, ...options.policy };
  const now = options.now ?? Date.now;
  const rows: Row[] = [];
  const used = new Map<string, number>();
  const fallbackLogs: Array<{ action: string; subjectPrefix: string }> = [];
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const secret = captchaKey(options.hmacKey, realm);
  const prune = () => {
    const cutoff = now() - policy.daySeconds * 1000;
    for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index]!.at <= cutoff) rows.splice(index, 1);
    for (const [key, expires] of used) if (expires <= now()) used.delete(key);
  };
  const note = async (event: AuditEvent) => {
    try { await options.audit?.(event); }
    catch { auditFallback(fallbackLogs, event); }
  };
  const challenge = () => altchaLib().createChallenge({
    algorithm: "PBKDF2/SHA-256",
    cost: options.captchaCost ?? policy.captchaCost,
    expiresAt: new Date(now() + policy.captchaTtlSeconds * 1000),
    hmacSignatureSecret: secret,
  });
  const captchaOk = async (payload: unknown): Promise<boolean> => {
    if (typeof payload !== "string" || payload.length === 0 || payload.length > 4096) return false;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { challenge?: Challenge; solution?: unknown };
      const signature = decoded.challenge?.signature;
      const expiresAt = decoded.challenge?.parameters?.expiresAt;
      if (!signature || !decoded.solution || typeof expiresAt !== "number") return false;
      const result = await altchaLib().verifySolution({ challenge: decoded.challenge, solution: decoded.solution, hmacSignatureSecret: secret });
      if (!result.verified || result.expired || used.has(`${realm}:${signature}`)) return false;
      used.set(`${realm}:${signature}`, expiresAt * 1000);
      return true;
    } catch { return false; }
  };
  const withChallenge = async (decision: Decision): Promise<Decision> => {
    if (decision.decision !== "captcha") return decision;
    return { ...decision, challenge: await challenge() };
  };
  return {
    realm,
    fallbackLogs,
    challenge,
    admitSignIn: (subjects, payload) => lock(async () => {
      prune();
      const preview = decideSignIn(rows, subjects, false, now(), policy);
      if (preview.decision === "limited") {
        await note({ action: "user.auth.limited", purpose: "sign-in", subject: subjects.pair ?? subjects.ip ?? subjects.account, outcome: "FAILURE" });
        return preview;
      }
      if (preview.decision === "captcha" && !await captchaOk(payload)) return withChallenge(preview);
      const decision = decideSignIn(rows, subjects, true, now(), policy);
      if (decision.decision === "allow" && decision.ticket) {
        for (const subject of [subjects.pair, subjects.ip]) {
          if (subject) rows.push({ purpose: "sign-in", subject, kind: "reserved", ticket: decision.ticket, at: now() });
        }
      }
      return decision;
    }),
    settleSignIn: ({ ticket: id, outcome, account, pair, ip }) => lock(async () => {
      prune();
      if (outcome === "ignore" || outcome === "success") {
        for (let index = rows.length - 1; index >= 0; index -= 1) if (id && rows[index]!.ticket === id) rows.splice(index, 1);
      }
      if (outcome === "success") {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]!;
          if (row.purpose === "sign-in" && row.kind === "failure" && (row.subject === account || row.subject === pair)) rows.splice(index, 1);
        }
      }
      if (outcome === "credential") {
        for (const row of rows) if (row.ticket === id && row.kind === "reserved") row.kind = "failure";
        rows.push({ purpose: "sign-in", subject: account, kind: "failure", ticket: id ?? ticket(), at: now() });
        await note({ action: "user.auth.failure", purpose: "sign-in", subject: account, outcome: "FAILURE" });
      }
      const failures = inWindow(rows, "sign-in", account, now() - policy.signInWindowSeconds * 1000, new Set(["failure"]));
      void ip;
      return { captchaNow: failures.length >= policy.accountCaptchaAfter };
    }),
    admitSmsIp: (ip, payload) => lock(async () => {
      prune();
      if (!ip) return { decision: "allow" };
      const subject = throttleDigest(options.hmacKey, realm, "ip", ip);
      const preview = decideSms(rows, { ip: subject }, false, now(), policy);
      if (preview.decision === "limited") {
        await note({ action: "user.auth.sms_limited", purpose: "sms-ip", subject, outcome: "FAILURE" });
        return preview;
      }
      if (preview.decision === "captcha" && !await captchaOk(payload)) return withChallenge(preview);
      const decision = decideSms(rows, { ip: subject }, true, now(), policy);
      if (decision.decision === "allow" && decision.ticket) rows.push({ purpose: "sms-ip", subject, kind: "reserved", ticket: decision.ticket, at: now() });
      return decision;
    }),
    settleSmsIp: (id, outcome) => lock(async () => {
      if (!id) return;
      const row = rows.find((item) => item.ticket === id && item.purpose === "sms-ip");
      if (!row) return;
      if (outcome === "release") rows.splice(rows.indexOf(row), 1);
      else row.kind = outcome === "sent" ? "sent" : "unknown";
    }),
    holdSmsPhone: (_client, phone) => lock(async () => {
      prune();
      const subject = throttleDigest(options.hmacKey, realm, "phone", phone);
      const decision = decideSms(rows, { phone: subject }, true, now(), policy);
      if (decision.decision !== "allow" || !decision.ticket) {
        if (decision.decision === "limited") await note({ action: "user.auth.sms_limited", purpose: "sms-phone", subject, outcome: "FAILURE" });
        return decision.decision === "captcha" ? { decision: "limited", retryAfter: policy.captchaTtlSeconds, durable: false } : { ...decision, durable: false };
      }
      rows.push({ purpose: "sms-phone", subject, kind: "sent", ticket: decision.ticket, at: now() });
      return { decision: "allow", ticket: decision.ticket, durable: false };
    }),
    releaseSmsPhone: (id) => lock(async () => {
      const index = rows.findIndex((row) => row.ticket === id && row.purpose === "sms-phone");
      if (index >= 0) rows.splice(index, 1);
    }),
  };
}

const EVENT_TABLE = `"zzsh_iam"."user_auth_throttle_event"`;
const CAPTCHA_TABLE = `"zzsh_iam"."user_auth_captcha_used"`;

async function pgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection already dead */ }
    throw error;
  } finally { client.release(); }
}

async function postgresNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now");
  const at = Number(result.rows[0]?.now);
  if (!Number.isSafeInteger(at) || at <= 0) throw new ThrottleDependencyError();
  return at;
}

async function loadRows(client: PoolClient, realm: string, subjects: readonly string[]): Promise<Row[]> {
  if (subjects.length === 0) return [];
  const result = await client.query<{ purpose: string; subject: string; kind: Kind; ticket: string; at: Date }>(
    `SELECT purpose, subject, kind, ticket, occurred_at AS at FROM ${EVENT_TABLE}
      WHERE realm = $1 AND subject = ANY($2::text[]) AND occurred_at > clock_timestamp() - interval '24 hours'`,
    [realm, subjects],
  );
  return result.rows.map((row) => ({ ...row, at: new Date(row.at).getTime() }));
}

async function lockSubjects(client: PoolClient, realm: string, purpose: string, subjects: readonly string[]): Promise<void> {
  for (const subject of [...new Set(subjects)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${realm}:${purpose}:${subject}`]);
    await client.query(
      `DELETE FROM ${EVENT_TABLE} WHERE realm = $1 AND purpose = $2 AND subject = $3 AND occurred_at <= clock_timestamp() - interval '24 hours'`,
      [realm, purpose, subject],
    );
  }
}

export function createPostgresUserAuthThrottle(pool: Pool, options: {
  hmacKey: string;
  realm?: string;
  policy?: Partial<UserThrottlePolicy>;
  audit?: (client: PoolClient, event: AuditEvent) => Promise<void>;
  captchaCost?: number;
}): UserAuthThrottle {
  const memory = createMemoryUserAuthThrottle({ hmacKey: options.hmacKey, ...(options.realm ? { realm: options.realm } : {}), ...(options.policy ? { policy: options.policy } : {}), ...(options.captchaCost ? { captchaCost: options.captchaCost } : {}) });
  const realm = options.realm ?? USER_REALM;
  if (realm !== USER_REALM) throw new Error("postgres throttle candidate is user-realm only");
  const policy: UserThrottlePolicy = { ...USER_THROTTLE_PROPOSAL, ...options.policy };
  const fallbackLogs = memory.fallbackLogs;
  const note = async (client: PoolClient, event: AuditEvent) => {
    if (!options.audit) return;
    await client.query("SAVEPOINT user_auth_throttle_audit");
    try {
      await options.audit(client, event);
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT user_auth_throttle_audit");
      auditFallback(fallbackLogs, event);
    }
    await client.query("RELEASE SAVEPOINT user_auth_throttle_audit");
  };
  const insert = (client: PoolClient, purpose: string, subject: string, kind: Kind, id: string) => client.query(
    `INSERT INTO ${EVENT_TABLE} (realm, purpose, subject, kind, ticket) VALUES ($1, $2, $3, $4, $5)`,
    [realm, purpose, subject, kind, id],
  );
  return {
    realm,
    fallbackLogs,
    challenge: () => memory.challenge(),
    async admitSignIn(subjects, payload) {
      try {
        return await pgTransaction(pool, async (client) => {
          const locked = [subjects.account, subjects.pair, subjects.ip].filter((value): value is string => !!value);
          await lockSubjects(client, realm, "sign-in", locked);
          const rows = await loadRows(client, realm, locked);
          const at = await postgresNow(client);
          const preview = decideSignIn(rows, subjects, false, at, policy);
          if (preview.decision === "limited") {
            await note(client, { action: "user.auth.limited", purpose: "sign-in", subject: subjects.pair ?? subjects.ip ?? subjects.account, outcome: "FAILURE" });
            return preview;
          }
          if (preview.decision === "captcha" && !await verifyOnClient(client, realm, options.hmacKey, payload)) {
            return { decision: "captcha" as const, challenge: await memory.challenge() };
          }
          const decision = decideSignIn(rows, subjects, true, at, policy);
          if (decision.decision === "allow" && decision.ticket) {
            for (const subject of [subjects.pair, subjects.ip]) if (subject) await insert(client, "sign-in", subject, "reserved", decision.ticket);
          }
          return decision;
        });
      } catch (error) {
        if (error instanceof ThrottleDependencyError) throw error;
        throw new ThrottleDependencyError();
      }
    },
    async settleSignIn(input) {
      try {
        return await pgTransaction(pool, async (client) => {
          await lockSubjects(client, realm, "sign-in", [input.account, input.pair, input.ip].filter((value): value is string => !!value));
          if (input.ticket && (input.outcome === "ignore" || input.outcome === "success")) {
            await client.query(`DELETE FROM ${EVENT_TABLE} WHERE realm = $1 AND ticket = $2 AND kind = 'reserved'`, [realm, input.ticket]);
          }
          if (input.outcome === "success") {
            const subjects = [input.account, input.pair].filter((value): value is string => !!value);
            await client.query(`DELETE FROM ${EVENT_TABLE} WHERE realm = $1 AND purpose = 'sign-in' AND kind = 'failure' AND subject = ANY($2::text[])`, [realm, subjects]);
          }
          if (input.outcome === "credential") {
            if (input.ticket) await client.query(`UPDATE ${EVENT_TABLE} SET kind = 'failure' WHERE realm = $1 AND ticket = $2 AND kind = 'reserved'`, [realm, input.ticket]);
            await insert(client, "sign-in", input.account, "failure", input.ticket ?? ticket());
            await note(client, { action: "user.auth.failure", purpose: "sign-in", subject: input.account, outcome: "FAILURE" });
          }
          const count = await client.query<{ failures: number }>(
            `SELECT count(*)::int AS failures FROM ${EVENT_TABLE}
              WHERE realm = $1 AND purpose = 'sign-in' AND subject = $2 AND kind = 'failure'
                AND occurred_at > clock_timestamp() - make_interval(secs => $3)`,
            [realm, input.account, policy.signInWindowSeconds],
          );
          return { captchaNow: (count.rows[0]?.failures ?? 0) >= policy.accountCaptchaAfter };
        });
      } catch { throw new ThrottleDependencyError(); }
    },
    async admitSmsIp(ip, payload) {
      if (!ip) return { decision: "allow" };
      const subject = throttleDigest(options.hmacKey, realm, "ip", ip);
      try {
        return await pgTransaction(pool, async (client) => {
          await lockSubjects(client, realm, "sms-ip", [subject]);
          const rows = await loadRows(client, realm, [subject]);
          const at = await postgresNow(client);
          const preview = decideSms(rows, { ip: subject }, false, at, policy);
          if (preview.decision === "limited") {
            await note(client, { action: "user.auth.sms_limited", purpose: "sms-ip", subject, outcome: "FAILURE" });
            return preview;
          }
          if (preview.decision === "captcha" && !await verifyOnClient(client, realm, options.hmacKey, payload)) {
            return { decision: "captcha" as const, challenge: await memory.challenge() };
          }
          const decision = decideSms(rows, { ip: subject }, true, at, policy);
          if (decision.decision === "allow" && decision.ticket) await insert(client, "sms-ip", subject, "reserved", decision.ticket);
          return decision;
        });
      } catch { throw new ThrottleDependencyError(); }
    },
    async settleSmsIp(id, outcome) {
      if (!id) return;
      try {
        await pgTransaction(pool, async (client) => {
          if (outcome === "release") await client.query(`DELETE FROM ${EVENT_TABLE} WHERE realm = $1 AND ticket = $2 AND kind = 'reserved'`, [realm, id]);
          else await client.query(`UPDATE ${EVENT_TABLE} SET kind = $3 WHERE realm = $1 AND ticket = $2 AND kind = 'reserved'`, [realm, id, outcome === "sent" ? "sent" : "unknown"]);
        });
      } catch { throw new ThrottleDependencyError(); }
    },
    async holdSmsPhone(client, phone) {
      const subject = throttleDigest(options.hmacKey, realm, "phone", phone);
      const run = async (held: PoolClient, durable: boolean) => {
        await lockSubjects(held, realm, "sms-phone", [subject]);
        const rows = await loadRows(held, realm, [subject]);
        const decision = decideSms(rows, { phone: subject }, true, await postgresNow(held), policy);
        if (decision.decision !== "allow" || !decision.ticket) {
          if (decision.decision === "limited") await note(held, { action: "user.auth.sms_limited", purpose: "sms-phone", subject, outcome: "FAILURE" });
          return { ...decision, durable };
        }
        await insert(held, "sms-phone", subject, "sent", decision.ticket);
        return { decision: "allow" as const, ticket: decision.ticket, durable };
      };
      try {
        if (client) return await run(client, true);
        return await pgTransaction(pool, (held) => run(held, true));
      } catch (error) {
        if (error && typeof error === "object" && "decision" in error) throw error;
        throw new ThrottleDependencyError();
      }
    },
    async releaseSmsPhone(id) {
      try {
        await pgTransaction(pool, (client) => client.query(`DELETE FROM ${EVENT_TABLE} WHERE realm = $1 AND ticket = $2 AND purpose = 'sms-phone'`, [realm, id]));
      } catch { throw new ThrottleDependencyError(); }
    },
  };
}

async function verifyOnClient(client: PoolClient, realm: string, hmacKey: string, payload: unknown): Promise<boolean> {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 4096) return false;
  const secret = captchaKey(hmacKey, realm);
  let decoded: { challenge?: Challenge; solution?: unknown };
  try { decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { challenge?: Challenge; solution?: unknown }; }
  catch { return false; }
  const signature = decoded.challenge?.signature;
  const expiresAt = decoded.challenge?.parameters?.expiresAt;
  if (!signature || signature.length > 128 || !decoded.solution || typeof expiresAt !== "number") return false;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${realm}:captcha:${signature}`]);
  await client.query(`DELETE FROM ${CAPTCHA_TABLE} WHERE realm = $1 AND expires_at < clock_timestamp() AND signature IN (SELECT signature FROM ${CAPTCHA_TABLE} WHERE expires_at < clock_timestamp() LIMIT 100)`, [realm]);
  const result = await altchaLib().verifySolution({ challenge: decoded.challenge, solution: decoded.solution, hmacSignatureSecret: secret });
  if (!result.verified || result.expired) return false;
  const inserted = await client.query(
    `INSERT INTO ${CAPTCHA_TABLE} (realm, signature, expires_at) VALUES ($1, $2, to_timestamp($3)) ON CONFLICT DO NOTHING`,
    [realm, signature, expiresAt],
  );
  return inserted.rowCount === 1;
}

export function createUserAuthThrottle(options: {
  hmacKey: string;
  pool?: Pool;
  store?: "memory" | "postgres";
  policy?: Partial<UserThrottlePolicy>;
  now?: () => number;
  audit?: (client: PoolClient | null, event: AuditEvent) => Promise<void>;
  captchaCost?: number;
  realm?: string;
}): UserAuthThrottle {
  if (options.store === "postgres") {
    if (!options.pool) throw new ThrottleDependencyError();
    return createPostgresUserAuthThrottle(options.pool, {
      hmacKey: options.hmacKey,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.realm ? { realm: options.realm } : {}),
      ...(options.captchaCost ? { captchaCost: options.captchaCost } : {}),
      ...(options.audit ? { audit: (client, event) => options.audit!(client, event) } : {}),
    });
  }
  return createMemoryUserAuthThrottle({
    hmacKey: options.hmacKey,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.realm ? { realm: options.realm } : {}),
    ...(options.captchaCost ? { captchaCost: options.captchaCost } : {}),
    ...(options.audit ? { audit: (event) => options.audit!(null, event) } : {}),
  });
}

const USER_PREFIX = "/api/auth/user";
const SIGN_IN = new Set(["/sign-in/identifier", "/sign-in/phone-number"]);
const SMS_SEND = new Set(["/phone-registration/send-otp", "/security/challenge/send"]);

function authPath(url: string): string {
  let pathname = "/";
  try { pathname = new URL(url).pathname; } catch { return "/"; }
  if (pathname === USER_PREFIX) return "/";
  return pathname.startsWith(`${USER_PREFIX}/`) ? pathname.slice(USER_PREFIX.length) : pathname;
}

function controlled(status: number, body: unknown, retryAfter?: number): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-zzsh-controlled-auth": "1",
  });
  if (retryAfter) headers.set("retry-after", String(retryAfter));
  return new Response(JSON.stringify(body), { status, headers });
}

function errorBody(status: number, code: string, message: string, requestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const reason = typeof extra.reason === "string" ? extra.reason : undefined;
  return {
    ...extra,
    error: { code, message, requestId, ...(reason ? { reason } : {}) },
  };
}

function phoneFrom(path: string, body: Record<string, unknown>): string | undefined {
  const raw = path === "/sign-in/identifier" ? body.identifier : body.phoneNumber;
  return normalizeMainlandPhone(raw) ?? undefined;
}

function knownSmsChannel(path: string, body: Record<string, unknown>): boolean {
  if (path === "/phone-registration/send-otp") return true;
  return body.channel === "phone";
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await request.text() || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function withUserAuthThrottle(handler: (request: Request) => Promise<Response>, throttle: UserAuthThrottle, hmacKey: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = authPath(request.url);
    const requestId = request.headers.get("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}`;
    if (request.method === "GET" && path === "/security/captcha/challenge") {
      try {
        const challenge = await throttle.challenge();
        return controlled(200, { provider: "local-pow", schema: 1, upgrade: "CAPTCHA_REQUIRED", challenge });
      } catch {
        return controlled(503, errorBody(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Authentication dependency unavailable", requestId, { reason: "AUTH_DEPENDENCY_UNAVAILABLE" }));
      }
    }
    const gated = request.method === "POST" && (SIGN_IN.has(path) || SMS_SEND.has(path));
    if (!gated) return handler(request);
    const body = await readJson(request);
    if (!body) return controlled(400, errorBody(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid", requestId));
    const captchaPayload = body.captcha;
    delete body.captcha;
    const headers = new Headers(request.headers);
    const ip = throttleClientIp(headers.get(USER_CLIENT_IP_FORWARD_HEADER) ?? undefined);
    headers.delete(USER_CLIENT_IP_FORWARD_HEADER);
    const forward = () => handler(new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) }));
    const dependency = () => controlled(503, errorBody(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Authentication dependency unavailable", requestId, { reason: "AUTH_DEPENDENCY_UNAVAILABLE" }));
    try {
      if (SIGN_IN.has(path)) {
        const phone = phoneFrom(path, body);
        const password = typeof body.password === "string" && body.password.length > 0;
        if (!phone || !password) return forward();
        const subjects = signInSubjects(hmacKey, phone, ip, throttle.realm);
        const admitted = await throttle.admitSignIn(subjects, captchaPayload);
        if (admitted.decision === "limited") {
          return controlled(429, errorBody(429, API_V1_ERROR_CODES.RATE_LIMITED, "尝试次数过多，请稍后再试", requestId, { reason: "RATE_LIMITED" }), admitted.retryAfter);
        }
        if (admitted.decision === "captcha") {
          return controlled(403, errorBody(403, API_V1_ERROR_CODES.FORBIDDEN, "请先完成安全验证。当前客户端可升级后再试，账号不会因此被锁定。", requestId, {
            reason: "CAPTCHA_REQUIRED", captchaRequired: true, provider: "local-pow", schema: 1, upgrade: "CAPTCHA_REQUIRED", challenge: admitted.challenge,
          }));
        }
        let upstream: Response;
        try { upstream = await forward(); }
        catch {
          await throttle.settleSignIn({ ticket: admitted.ticket, outcome: "ignore", ...subjects });
          throw new ThrottleDependencyError();
        }
        const outcome = upstream.status === 401 ? "credential" : upstream.ok ? "success" : "ignore";
        let settled: { captchaNow: boolean };
        try { settled = await throttle.settleSignIn({ ticket: admitted.ticket, outcome, ...subjects }); }
        catch {
          if (upstream.ok) {
            console.warn(JSON.stringify({ event: "user.auth.throttle_settlement_failed", purpose: "sign-in", upstreamAccepted: true }));
            return upstream;
          }
          return dependency();
        }
        if (outcome === "credential" && settled.captchaNow) {
          const challenge = await throttle.challenge().catch(() => undefined);
          return controlled(401, errorBody(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication request rejected", requestId, {
            ...(challenge ? { reason: "CAPTCHA_REQUIRED", captchaRequired: true, provider: "local-pow", schema: 1, upgrade: "CAPTCHA_REQUIRED", challenge } : {}),
          }));
        }
        return upstream;
      }
      let smsTicket: string | undefined;
      if (knownSmsChannel(path, body)) {
        const admitted = await throttle.admitSmsIp(ip, captchaPayload);
        if (admitted.decision === "limited") {
          return controlled(429, errorBody(429, API_V1_ERROR_CODES.RATE_LIMITED, "发送过于频繁，请稍后再试", requestId, { reason: "RATE_LIMITED" }), admitted.retryAfter);
        }
        if (admitted.decision === "captcha") {
          return controlled(403, errorBody(403, API_V1_ERROR_CODES.FORBIDDEN, "请先完成安全验证后再获取验证码。", requestId, {
            reason: "CAPTCHA_REQUIRED", captchaRequired: true, provider: "local-pow", schema: 1, upgrade: "CAPTCHA_REQUIRED", challenge: admitted.challenge,
          }));
        }
        smsTicket = admitted.ticket;
      }
      let upstream: Response;
      try { upstream = await forward(); }
      catch {
        await throttle.settleSmsIp(smsTicket, "unknown");
        throw new ThrottleDependencyError();
      }
      const smsOutcome = upstream.ok ? "sent" : upstream.status >= 500 ? "unknown" : "release";
      try { await throttle.settleSmsIp(smsTicket, smsOutcome); }
      catch {
        if (upstream.ok) {
          console.warn(JSON.stringify({ event: "user.auth.throttle_settlement_failed", purpose: "sms", upstreamAccepted: true }));
          return upstream;
        }
        return dependency();
      }
      return upstream;
    } catch (error) {
      if (error instanceof ThrottleDependencyError) return dependency();
      throw error;
    }
  };
}
