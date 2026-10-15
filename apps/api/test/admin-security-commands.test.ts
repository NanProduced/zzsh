// 离线命令身份/回执/事务边界检查。不连 PostgreSQL：真实 PG 事务、并发与 Cookie 交付
// 仍需 real-test-plan.md 的受控窗口；本套件用真实 Better Auth 内部适配器与 dispatch 装配，
// 只把数据库与会话上下文换成可断言的夹具。
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";

import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { buildAdminSelfSecurityInterceptor } from "../src/auth/auth-runtime";
import { adminSelfSecurityHttpRequest } from "../src/auth/admin-self-security-plugin";
import { handleAdminSecurity, type AuthSecurityOptions } from "../src/auth/auth-security";
import { adminSessionCreationHooks, assertAdminCommandAuthorizedInTransaction } from "../src/auth/admin-auth-session";
import {
  ADMIN_SECURITY_COMMAND_TTL_MS,
  adminSecurityCommandFingerprint,
  adminSecurityCommandId,
  adminSecurityCommandScopeKey,
  claimAdminSecurityCommand,
  deriveAdminSecurityCommandKey,
  readAdminSecurityCommandReceipt,
  readBackupCodeGeneration,
  recordAdminSecurityCommandRejection,
  writeAdminSecurityCommandReceipt,
  type AdminSecurityCommandScope,
} from "../src/auth/admin-security-commands";

const ADMIN_ORIGIN = "http://127.0.0.1:4291";
const API_ORIGIN = "http://127.0.0.1:4292";
const SECRET = "offline-fixture-admin-secret-value-0123456789";
const COMMAND_KEY = deriveAdminSecurityCommandKey(SECRET);
const PIN = "246810";
const NEXT_PIN = "135790";
const CURRENT_PASSWORD = "current-fixture-password";
const NEW_PASSWORD = "new-fixture-password-123";

type CommandRow = {
  adminUserId: string;
  commandId: string;
  action: string;
  targetKind: string;
  targetId: string;
  fingerprint: string;
  status: string;
  reason: string | null;
  result: unknown;
  rejection: unknown;
  requestId: string | null;
  createdAt: Date;
  retentionUntil: Date;
};

type QueryLog = { handle: "pool" | "client"; sql: string; values: unknown[] };

const USER_COLUMNS: Record<string, unknown> = {
  id: "admin_one", name: "隔离测试管理员", email: "admin@example.invalid", emailVerified: true, image: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  username: "zz00001", displayUsername: "ZZ00001", twoFactorEnabled: true,
  phoneNumber: null, phoneNumberVerified: false, suspended: false,
};

function splitColumns(list: string): string[] {
  return list.split(",").map((part) => part.trim().replace(/"/g, "").split(".").pop()!.replace(/"/g, ""));
}

function loggerStub() {
  return { info() {}, warn() {}, error() {}, debug() {}, success() {}, level: "error" };
}

/**
 * 夹具按语句形态严格分派：
 * - 变更类（INSERT/UPDATE/DELETE）先于任何 `FROM <table>` 读分支判断，
 *   否则 `DELETE ... (SELECT ...)` 的子查询会被宽泛读分支吞掉，清理用例假通过；
 * - 自有 plain SQL 取对象行，drizzle 生成的语句取数组行（与真实驱动一致）。
 */
class SecurityCommandFixture {
  actorId = "admin_one";
  sessionId = "session_one";
  status: "ACTIVE" | "PENDING_ENROLLMENT" | "FROZEN" = "ACTIVE";
  isBoss = false;
  twoFactorEnabled = true;
  suspended = false;
  /** 事务内复核读取的当前真实状态。 */
  locked = false;
  sessionExists = true;
  sessionExpiresAt = new Date(Date.now() + 3_600_000);
  /** 事务前快照：用于构造"快照未锁、事务内已锁"的 TOCTOU 反例。 */
  snapshotLocked = false;
  pinHash: string | null = null;
  pinFailures = 0;
  accountPassword = `hash:${CURRENT_PASSWORD}`;
  twoFactorRowId: string | null = "factor1";
  backupValue: string | null = null;

  commands = new Map<string, CommandRow>();
  generations = new Map<string, { generation: number; generationId: string; generatedAt: Date }>();
  generationTableExists = true;
  failAudit = false;
  /** SDK `verification` 清理的落点；本包回执不应出现在这里。 */
  verification = new Map<string, { value: string; expiresAt: Date }>();
  audits: { action: string; outcome: string; reason: string | null }[] = [];
  queries: QueryLog[] = [];
  poolSecurityUpdates = 0;
  poolHookRuns = 0;
  deletedTables: string[] = [];

  async connect(): Promise<PoolClient> {
    const self = this;
    let before: object | undefined;
    return {
      query: async (sql: unknown, values?: unknown[]) => {
        const text = typeof sql === "string" ? sql : String((sql as { text?: string }).text);
        if (text === "BEGIN") before = structuredClone({ commands: self.commands, generations: self.generations,
          backupValue: self.backupValue, accountPassword: self.accountPassword, audits: self.audits,
          sessionExists: self.sessionExists, sessionId: self.sessionId, sessionExpiresAt: self.sessionExpiresAt,
          locked: self.locked, pinHash: self.pinHash, pinFailures: self.pinFailures });
        if (text === "ROLLBACK" && before) Object.assign(self, before);
        return self.dispatch("client", text, Array.isArray(values) ? values : ((sql as { values?: unknown[] }).values ?? []));
      },
      release: () => undefined,
    } as unknown as PoolClient;
  }

  async poolQuery(sql: string, values: unknown[] = []) {
    return this.dispatch("pool", sql, values);
  }

  get pool(): Pool {
    const self = this;
    return {
      query: (sql: string, values?: unknown[]) => self.poolQuery(sql, values),
      connect: () => self.connect(),
    } as unknown as Pool;
  }

  key(adminUserId: string, commandId: string) {
    return `${adminUserId} ${commandId}`;
  }

  private async dispatch(handle: "pool" | "client", rawSql: string, values: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = String(rawSql).replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    this.queries.push({ handle, sql: text, values });
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });

    if (/^(begin|commit|rollback)/i.test(text)) return result([]);
    if (text.includes("set_config")) return result([]);
    if (text.includes("pg_advisory_xact_lock")) return result([]);

    // ---- 变更类：必须先于任何 FROM 读分支分派 ----
    if (lower.includes('"zzsh_iam"."admin_backup_code_generation"') && !this.generationTableExists) {
      throw Object.assign(new Error("Generation schema is not installed"), { code: "42P01" });
    }
    if (lower.startsWith('insert into "zzsh_iam"."admin_backup_code_generation"')) {
      const id = String(values[0]);
      const row = { generation: (this.generations.get(id)?.generation ?? 0) + 1,
        generationId: String(values[1]), generatedAt: new Date() };
      this.generations.set(id, row);
      return result([row]);
    }
    if (lower.startsWith("delete from")) {
      const table = lower.replace(/^delete from\s+/, "").split(/\s+/)[0] ?? "";
      this.deletedTables.push(table);
      if (table === '"zzsh_auth_admin"."verification"') {
        let removed = 0;
        for (const [identifier, row] of [...this.verification]) {
          if (row.expiresAt.getTime() <= Date.now()) { this.verification.delete(identifier); removed += 1; }
        }
        return { rows: [], rowCount: removed };
      }
      if (table === '"zzsh_auth_admin"."session"') {
        const affected = this.sessionExists ? 1 : 0;
        this.sessionExists = false;
        return { rows: [], rowCount: affected };
      }
      if (table === '"zzsh_iam"."admin_security_command"') {
        throw new Error(`fixture refused to delete command identity rows: ${text}`);
      }
      return { rows: [], rowCount: 0 };
    }
    if (lower.startsWith('insert into "zzsh_iam"."admin_security_command"')) {
      const key = this.key(String(values[0]), String(values[1]));
      if (this.commands.has(key)) throw new Error("duplicate admin_security_command row");
      this.commands.set(key, {
        adminUserId: String(values[0]), commandId: String(values[1]), action: String(values[2]),
        targetKind: String(values[3]), targetId: String(values[4]), fingerprint: String(values[5]),
        status: String(values[6]),
        reason: values[7] === null || values[7] === undefined ? null : String(values[7]),
        result: values[8] === null || values[8] === undefined ? null : JSON.parse(String(values[8])),
        rejection: values[9] === null || values[9] === undefined ? null : JSON.parse(String(values[9])),
        requestId: values[10] === null || values[10] === undefined ? null : String(values[10]),
        createdAt: new Date(values[11] as Date),
        retentionUntil: new Date(values[12] as Date),
      });
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('insert into "zzsh_iam"."audit_event"')) {
      if (this.failAudit) throw new Error("Audit unavailable in fixture");
      this.audits.push({
        action: String(values[4]),
        outcome: String(values[7]),
        reason: values[9] === null || values[9] === undefined ? null : String(values[9]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('insert into "zzsh_auth_admin"."session"')) {
      const insert = text.match(/insert into "zzsh_auth_admin"\."session" \(([^)]*)\) values \(([^)]*)\) returning (.+)$/i);
      assert.ok(insert, `unexpected session insert: ${text}`);
      const cols = splitColumns(insert![1]!);
      const placeholders = insert![2]!.split(",").map((part) => part.trim());
      const byName: Record<string, unknown> = {};
      let parameter = 0;
      cols.forEach((col, index) => { byName[col] = placeholders[index] === "default" ? null : values[parameter++]; });
      this.sessionExists = true;
      this.sessionId = String(byName.id);
      this.sessionExpiresAt = new Date(byName.expiresAt as Date);
      this.locked = false;
      this.pinHash = null;
      this.pinFailures = 0;
      return { rows: [splitColumns(insert![3]!).map((name) => byName[name])], rowCount: 1 };
    }
    if (lower.startsWith('update "zzsh_auth_admin"."session"')) {
      if (text.includes('"pinFailures" = $1, "locked" = $2')) {
        this.pinFailures = Number(values[0]);
        this.locked = Boolean(values[1]);
      } else if (text.includes('"pinHash" = $1')) {
        this.pinHash = String(values[0]);
        this.pinFailures = 0;
        if (text.includes('"locked" = false')) this.locked = false;
      }
      return { rows: [], rowCount: 1 };
    }
    if (lower.startsWith('update "zzsh_auth_admin"."account"')) { this.accountPassword = String(values[1]); return { rows: [], rowCount: 1 }; }
    if (lower.startsWith('update "zzsh_auth_admin"."twofactor"')) { this.backupValue = String(values[1]); return { rows: [], rowCount: 1 }; }
    if (lower.startsWith('update "zzsh_iam"."admin_security"')) {
      if (handle === "pool") this.poolSecurityUpdates += 1;
      return { rows: [], rowCount: 1 };
    }

    // ---- 读取 ----
    if (lower.startsWith('select "status", "is_boss"')) return result([{ status: this.status, isBoss: this.isBoss, passwordChangeRequired: false }]);
    if (lower.startsWith('select "status" from "zzsh_iam"."admin_security"')) return result([{ status: this.status }]);
    if (lower.startsWith('select "suspended" from "zzsh_auth_admin"."user"')) return result([{ suspended: this.suspended }]);
    if (lower.startsWith('select s."locked"')) {
      if (!this.sessionExists || this.sessionExpiresAt.getTime() <= Date.now()) return result([]);
      return result([{
        locked: this.locked, pinHash: this.pinHash, pinFailures: this.pinFailures,
        expiresAt: this.sessionExpiresAt, suspended: this.suspended, twoFactorEnabled: this.twoFactorEnabled,
      }]);
    }
    if (lower.startsWith('select "pinhash"')) return result([{ pinHash: this.pinHash, pinFailures: this.pinFailures, locked: this.locked }]);
    if (lower.includes('from "zzsh_auth_admin"."account"')) return result([{ id: "credential1", password: this.accountPassword }]);
    if (lower.startsWith('select "id" from "zzsh_auth_admin"."twofactor"')) return this.twoFactorRowId ? result([{ id: this.twoFactorRowId }]) : result([]);
    if (lower.startsWith('select "action", "target_kind"')) {
      const row = this.commands.get(this.key(String(values[0]), String(values[1])));
      return row ? result([{
        action: row.action, targetKind: row.targetKind, targetId: row.targetId, fingerprint: row.fingerprint,
        status: row.status, reason: row.reason, result: row.result, rejection: row.rejection,
        createdAt: row.createdAt, retentionUntil: row.retentionUntil, requestId: row.requestId,
      }]) : result([]);
    }
    if (lower.startsWith('select "generation", "generation_id"')) {
      const row = this.generations.get(String(values[0]));
      return result(row ? [row] : []);
    }
    if (lower.startsWith('select "value" from "zzsh_auth_admin"."verification"') || lower.startsWith('select "id", "value" from "zzsh_auth_admin"."verification"')) {
      const row = this.verification.get(String(values[0]));
      return row ? result([{ id: "row", value: row.value }]) : result([]);
    }
    if (lower.startsWith('select "id", "name"')) {
      const match = text.match(/^select (.+?) from "zzsh_auth_admin"\."user"/i);
      assert.ok(match, `unexpected drizzle user select: ${text}`);
      return result([splitColumns(match![1]!).map((name) => USER_COLUMNS[name])]);
    }
    throw new Error(`Unhandled fixture query: ${text}`);
  }

  insertReceipt(row: Omit<CommandRow, "retentionUntil">) {
    this.commands.set(this.key(row.adminUserId, row.commandId), {
      ...row,
      retentionUntil: new Date(row.createdAt.getTime() + ADMIN_SECURITY_COMMAND_TTL_MS),
    });
  }
}

function securityOptions(fixture: SecurityCommandFixture): AuthSecurityOptions {
  const auth = {
    api: {
      getSession: async () => ({
        user: { id: fixture.actorId, name: "隔离测试管理员", username: "ZZ00001", twoFactorEnabled: fixture.twoFactorEnabled, suspended: fixture.suspended },
        session: { id: fixture.sessionId, userId: fixture.actorId, locked: fixture.snapshotLocked },
      }),
    },
  };
  return {
    pool: fixture.pool,
    adminAuth: auth,
    userAuth: auth,
    apiOrigin: API_ORIGIN,
    adminOrigin: ADMIN_ORIGIN,
    userOrigin: "http://127.0.0.1:4290",
    hashPassword: async (value: string) => `hash:${value}`,
    verifyPassword: async (value: string, hash: string) => hash === `hash:${value}`,
    adminSecurityCommandKey: COMMAND_KEY,
    rateLimitState: new Map(),
    securityVerificationBudget: { inFlight: 0 },
    testOperationsEnabled: false,
  } as unknown as AuthSecurityOptions;
}

function capture() {
  let status = 200;
  let body: unknown;
  const headers: Record<string, unknown> = {};
  const response = {
    setHeader(name: string, value: unknown) { headers[name] = value; return response; },
    status(value: number) { status = value; return response; },
    json(value: unknown) { body = value; return response; },
    send(value: unknown) { body = value; return response; },
  };
  return { response, result: () => ({ status, body: body as Record<string, unknown>, headers }) };
}

type Routed = { status: number; body: Record<string, unknown>; headers: Record<string, unknown> };

async function route(fixture: SecurityCommandFixture, path: string, body: unknown, commandId?: string | string[], method = "POST"): Promise<Routed> {
  const output = capture();
  const headers: Record<string, string | string[] | undefined> = { origin: ADMIN_ORIGIN, "x-request-id": "req_offline" };
  if (commandId !== undefined) headers["idempotency-key"] = commandId;
  await handleAdminSecurity(
    { method, url: `/api/v1/admin/security${path}`, originalUrl: `/api/v1/admin/security${path}`, body, headers },
    output.response as never,
    securityOptions(fixture),
  );
  return output.result();
}

function httpCommandStub(invoke: (input: any) => Promise<Response>) {
  return { handler: async (request: Request) => invoke({ body: await request.clone().json(), headers: request.headers, asResponse: true }) };
}

function errorOf(body: Record<string, unknown>): { code?: string; message?: string; reason?: string; requestId?: string } {
  return (body.error ?? {}) as { code?: string; message?: string; reason?: string; requestId?: string };
}

function scope(overrides: Partial<AdminSecurityCommandScope> = {}): AdminSecurityCommandScope {
  return {
    adminUserId: "admin_one",
    commandId: "idem_offline0001",
    action: "pin.set",
    target: { kind: "session", id: "session_one" },
    fingerprint: adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.set", "session_one", PIN]),
    ...overrides,
  };
}

async function withClient<T>(fixture: SecurityCommandFixture, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await fixture.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- 插件上下文

type PluginCtx = {
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  responseHeaders: Headers;
  json: (body: unknown) => unknown;
  context: Record<string, unknown>;
  getSignedCookie: () => Promise<undefined>;
  setSignedCookie: () => Promise<void>;
  setCookie: () => void;
};

function pluginOptions(fixture: SecurityCommandFixture) {
  return {
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        locked: { type: "boolean", defaultValue: false, input: false },
        pinHash: { type: "string", required: false, input: false, returned: false },
        pinFailures: { type: "number", defaultValue: 0, input: false },
      },
    },
    advanced: {},
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    // 若实现错误地把 pool 版钩子交给 SDK，这里会计数并在断言里暴露（F2）。
    databaseHooks: {
      session: {
        create: {
          before: async () => { fixture.poolHookRuns += 1; return { data: undefined }; },
          after: async () => { fixture.poolHookRuns += 1; },
        },
      },
    },
  };
}

function pluginCtx(fixture: SecurityCommandFixture, options: { commandId?: string; locked?: boolean } = {}): PluginCtx {
  const { locked = fixture.snapshotLocked } = options;
  return {
    method: "POST",
    headers: new Headers({ "idempotency-key": options.commandId ?? "idem_plugin", "x-request-id": "req_offline" }),
    body: { password: CURRENT_PASSWORD },
    responseHeaders: new Headers(),
    json: (body) => body,
    context: {
      session: {
        user: { id: fixture.actorId, twoFactorEnabled: fixture.twoFactorEnabled, suspended: fixture.suspended, name: "隔离测试管理员" },
        session: { id: fixture.sessionId, userId: fixture.actorId, locked, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      },
      password: {
        verify: async ({ password }: { password: string }) => `hash:${password}` === fixture.accountPassword,
        hash: async (value: string) => `hash:${value}`,
        config: { minPasswordLength: 12, maxPasswordLength: 128 },
      },
      options: pluginOptions(fixture),
      logger: loggerStub(),
      generateId: ({ model }: { model: string }) => `${model}_generated`,
      secret: SECRET,
      secretConfig: SECRET,
      sessionConfig: { expiresIn: 7 * 24 * 60 * 60 },
      authCookies: { sessionToken: { name: "zzsh_admin.session_token", attributes: {} }, dontRememberToken: { name: "zzsh_admin.dont_remember", attributes: {} } },
      setNewSession() { /* 夹具无需真实 Cookie 上下文 */ },
    },
    getSignedCookie: async () => undefined,
    setSignedCookie: async () => {},
    setCookie() {},
  };
}

function wrongPasswordCtx(fixture: SecurityCommandFixture, commandId: string): PluginCtx {
  const ctx = pluginCtx(fixture, { commandId });
  ctx.body.password = "wrong-fixture-password";
  return ctx;
}

async function buildPlugin(fixture: SecurityCommandFixture) {
  const { buildAdminSelfSecurityPlugin } = await import("../src/auth/admin-self-security-plugin");
  return buildAdminSelfSecurityPlugin({ pool: fixture.pool, adminSecret: SECRET });
}

function rejectsWith(status: number, reason?: string) {
  return (error: unknown) => {
    const candidate = error as { status?: number; reason?: string };
    assert.equal(candidate?.status, status, `expected status ${status}, got ${candidate?.status} (${candidate?.reason ?? ""})`);
    if (reason !== undefined) assert.equal(candidate?.reason, reason);
    return true;
  };
}

// ================================================================= 用例

test("命令标识仅缺失时为旧调用，显式非法/空/重复/超长必须400", () => {
  assert.equal(adminSecurityCommandId({ "idempotency-key": "idem_valid" }), "idem_valid");
  assert.equal(adminSecurityCommandId(new Headers({ "idempotency-key": "idem_header" })), "idem_header");
  assert.equal(adminSecurityCommandId({}), undefined); assert.equal(adminSecurityCommandId(undefined), undefined);
  for (const value of ["", " ", "invalid key", "idem_a, idem_b", "a".repeat(129), ["idem_first", "idem_second"], ["idem_same", "idem_same"], []]) {
    assert.throws(() => adminSecurityCommandId({ "idempotency-key": value }), rejectsWith(400, "invalid_idempotency_key"));
  }
  assert.throws(() => adminSecurityCommandId({ "Idempotency-Key": "idem_one", "idempotency-key": "idem_two" }), rejectsWith(400, "invalid_idempotency_key"));
  const duplicate = new Headers(); duplicate.append("idempotency-key", "idem_one"); duplicate.append("idempotency-key", "idem_one");
  assert.throws(() => adminSecurityCommandId(duplicate), rejectsWith(400, "invalid_idempotency_key"));
});

test("作用域键按管理员与命令标识隔离，指纹覆盖意图且随密钥轮换失效", () => {
  assert.equal(adminSecurityCommandScopeKey("admin_one", "idem_a"), adminSecurityCommandScopeKey("admin_one", "idem_a"));
  assert.notEqual(adminSecurityCommandScopeKey("admin_one", "idem_a"), adminSecurityCommandScopeKey("admin_two", "idem_a"));

  const base = adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.set", "session_one", PIN]);
  assert.equal(base, adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.set", "session_one", PIN]));
  assert.notEqual(base, adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.change", "session_one", PIN]));
  assert.notEqual(base, adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.set", "session_other", PIN]));
  assert.notEqual(base, adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.set", "session_one", NEXT_PIN]));
  assert.equal(base.includes(PIN), false, "低熵 PIN 只以 HMAC 输出出现");
  const rotated = deriveAdminSecurityCommandKey("offline-fixture-admin-secret-value-9999999999");
  assert.notEqual(adminSecurityCommandFingerprint(rotated, ["pin.set", "session_one", PIN]), base);
  assert.equal(base.length, 64);
});

test("同标识同意图回放、异图与过保留期都拒绝重新执行", async () => {
  const fixture = new SecurityCommandFixture();
  const original = scope();
  await withClient(fixture, async (client) => {
    assert.deepEqual(await claimAdminSecurityCommand(client, original), { mode: "execute" });
    await writeAdminSecurityCommandReceipt(client, original, { status: "completed", result: { pinConfigured: true } }, "req_offline");
    const replay = await claimAdminSecurityCommand(client, original);
    assert.equal(replay.mode, "replay");
    if (replay.mode === "replay") assert.equal(replay.receipt.result?.pinConfigured, true);

    await assert.rejects(claimAdminSecurityCommand(client, scope({ action: "pin.change" })), { status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    await assert.rejects(
      claimAdminSecurityCommand(client, scope({ fingerprint: adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.set", "session_one", NEXT_PIN]) })),
      { status: 409, code: "IDEMPOTENCY_KEY_REUSED" },
    );
  });

  const staleCreatedAt = new Date(Date.now() - ADMIN_SECURITY_COMMAND_TTL_MS - 1000);
  fixture.insertReceipt({
    adminUserId: "admin_one", commandId: "idem_stale", action: "pin.set",
    targetKind: "session", targetId: "session_one", fingerprint: scope().fingerprint,
    status: "completed", reason: null, result: { pinConfigured: true }, rejection: null, requestId: null,
    createdAt: staleCreatedAt,
  });
  await withClient(fixture, async (client) => {
    await assert.rejects(claimAdminSecurityCommand(client, scope({ commandId: "idem_stale" })), { status: 409, code: "IDEMPOTENCY_KEY_REUSED" },
      "过保留期只拒绝重新执行，绝不回到 execute");
  });
  assert.equal((await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_stale")).status, "expired");
});

// ---- F4 ----

test("F4 过期清理只作用于 SDK verification，命令身份行永不被删且旧 key 仍被拒", async () => {
  const fixture = new SecurityCommandFixture();
  const original = scope({ commandId: "idem_expiry" });
  await withClient(fixture, async (client) => {
    await writeAdminSecurityCommandReceipt(client, original, { status: "completed", result: { generated: true, generation: 1 } }, "req_offline");
  });

  // 模拟 SDK findVerificationValue 的清理谓词（内部适配器执行的那类 DELETE）。
  fixture.verification.set("reset-password:stale", { value: "x", expiresAt: new Date(Date.now() - 1000) });
  await fixture.poolQuery(`DELETE FROM "zzsh_auth_admin"."verification" WHERE "id" IN (SELECT "id" FROM "zzsh_auth_admin"."verification" WHERE "expiresAt" <= clock_timestamp() LIMIT 200)`);
  assert.equal(fixture.verification.size, 0, "过期 verification 行会被 SDK 清理");
  assert.equal(fixture.deletedTables.filter((table) => table.includes("admin_security_command")).length, 0,
    "命令身份行不允许出现在任何 DELETE 目标中");

  const stale = new Date(Date.now() - ADMIN_SECURITY_COMMAND_TTL_MS - 1000);
  fixture.insertReceipt({
    adminUserId: "admin_one", commandId: "idem_expiry", action: "backup-codes.generate",
    targetKind: "credential", targetId: "admin_one", fingerprint: scope({ action: "backup-codes.generate" }).fingerprint,
    status: "completed", reason: null, result: { generated: true, generation: 1 }, rejection: null, requestId: null,
    createdAt: stale,
  });
  await withClient(fixture, async (client) => {
    await assert.rejects(claimAdminSecurityCommand(client, scope({ commandId: "idem_expiry", action: "backup-codes.generate" })),
      { status: 409, code: "IDEMPOTENCY_KEY_REUSED" }, "回执过期后旧 key 也不能重新执行");
  });
  assert.equal((await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_expiry")).status, "expired",
    "读不到内容也要能区分 expired，而不是 unconfirmed");
  assert.equal((await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_never")).status, "unconfirmed");
});

test("回执与拒绝回执都不落秘密，已有回执时拒绝写入让位且不重复审计", async () => {
  const fixture = new SecurityCommandFixture();
  const command = scope({ action: "pin.change", fingerprint: adminSecurityCommandFingerprint(COMMAND_KEY, ["pin.change", "session_one", PIN, NEXT_PIN]) });
  await withClient(fixture, async (client) => {
    await writeAdminSecurityCommandReceipt(client, command, {
      status: "rejected",
      reason: "invalid_pin",
      rejection: { status: 401, code: "UNAUTHENTICATED", message: "PIN rejected", reason: "invalid_pin" },
    }, "req_offline");
  });

  const stored = [...fixture.commands.values()].map((row) => JSON.stringify({ result: row.result, rejection: row.rejection, reason: row.reason })).join("");
  assert.equal(stored.includes(PIN), false);
  assert.equal(stored.includes(NEXT_PIN), false);
  assert.equal(stored.includes("hash:"), false);

  const written = await recordAdminSecurityCommandRejection(fixture.pool, command,
    { status: 401, code: "UNAUTHENTICATED", message: "PIN rejected", reason: "invalid_pin" }, "req_offline",
    (tx) => tx.query(
      `INSERT INTO "zzsh_iam"."audit_event" ("id","actor_type","actor_id","session_id","action","object_type","object_id","outcome","request_id","reason","occurred_at","details") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11::jsonb)`,
      ["audit_1", "admin", "admin_one", "session_one", "admin.pin.change", "admin_session", "session_one", "FAILURE", "req_offline", "invalid_pin", "{}"],
    ) as never);
  assert.equal(written, false, "已有回执时拒绝写入必须让位");
  assert.equal(fixture.audits.length, 0);
});

test("读取原结果只按本人身份投影，区分完成/拒绝/未确认/过保留期且不含指纹", async () => {
  const fixture = new SecurityCommandFixture();
  await withClient(fixture, async (client) => {
    await writeAdminSecurityCommandReceipt(client,
      scope({ commandId: "idem_done", action: "backup-codes.generate", target: { kind: "credential", id: "admin_one" }, fingerprint: adminSecurityCommandFingerprint(COMMAND_KEY, ["backup-codes.generate", "admin_one", "pw"]) }),
      { status: "completed", result: { generated: true, generation: 3, codeCount: 10 } }, "req_offline");
    await writeAdminSecurityCommandReceipt(client, scope({ commandId: "idem_rejected", action: "pin.change" }), {
      status: "rejected", reason: "invalid_pin",
      rejection: { status: 401, code: "UNAUTHENTICATED", message: "PIN rejected", reason: "invalid_pin" },
    }, "req_offline");
    await writeAdminSecurityCommandReceipt(client, scope({ commandId: "idem_pin" }), { status: "completed", result: { pinConfigured: true } }, "req_offline");
  });

  const done = await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_done");
  assert.equal(done.status, "completed");
  assert.equal(done.action, "backup-codes.generate");
  assert.deepEqual(done.result, { generated: true, generation: 3, codeCount: 10 });
  assert.equal("fingerprint" in done, false);
  assert.equal("targetSessionId" in done, false, "凭据类命令不暴露会话标识");

  const pin = await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_pin");
  assert.equal(pin.targetKind, "session");
  assert.equal(pin.targetSessionId, "session_one");

  const rejection = await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_rejected");
  assert.equal(rejection.status, "rejected");
  assert.equal(rejection.reason, "invalid_pin");

  assert.equal((await readAdminSecurityCommandReceipt(fixture.pool, "admin_one", "idem_missing")).status, "unconfirmed");
  assert.equal((await readAdminSecurityCommandReceipt(fixture.pool, "admin_two", "idem_done")).status, "unconfirmed",
    "只知道他人命令标识不能读到他人状态");
});

// ---- F3 ----

test("F3 PIN 更改拒绝重放保持原拒绝：401 + reason，PIN 不变也不重复扣次", async () => {
  const fixture = new SecurityCommandFixture();
  fixture.pinHash = `hash:${PIN}`;
  const body = { currentPin: "000000", newPin: NEXT_PIN };

  const first = await route(fixture, "/pin/change", body, "idem_pin_reject");
  assert.equal(first.status, 401);
  assert.equal(errorOf(first.body).reason, "invalid_pin");
  assert.equal(fixture.pinFailures, 1);
  assert.equal(fixture.pinHash, `hash:${PIN}`, "被拒绝的命令不得改动 PIN");

  const repeat = await route(fixture, "/pin/change", body, "idem_pin_reject");
  assert.equal(repeat.status, 401, "重放必须复现原 HTTP 拒绝");
  assert.equal(repeat.body.status, undefined, "拒绝重放不得出现 CHANGED 成功信封");
  assert.equal(errorOf(repeat.body).reason, "invalid_pin");
  assert.equal(fixture.pinFailures, 1, "同命令重复不重复扣次");

  const fresh = await route(fixture, "/pin/change", body, "idem_pin_reject_2");
  assert.equal(fresh.status, 401);
  assert.equal(fixture.pinFailures, 2, "换新命令标识的真实尝试仍按原规则计次");

  const correct = await route(fixture, "/pin/change", { currentPin: PIN, newPin: NEXT_PIN }, "idem_pin_ok");
  assert.equal(correct.status, 200);
  assert.equal(correct.body.status, "CHANGED");
  assert.equal(fixture.pinHash, `hash:${NEXT_PIN}`);
  assert.equal(fixture.pinFailures, 0);
});

test("F3 PIN 首设已配置的拒绝重放保持 409，不显示 SET 成功", async () => {
  const fixture = new SecurityCommandFixture();
  fixture.pinHash = `hash:${PIN}`;

  const first = await route(fixture, "/pin/set", { pin: NEXT_PIN }, "idem_set_reject");
  assert.equal(first.status, 409);
  assert.equal(errorOf(first.body).reason, "pin_already_configured");

  const repeat = await route(fixture, "/pin/set", { pin: NEXT_PIN }, "idem_set_reject");
  assert.equal(repeat.status, 409);
  assert.equal(repeat.body.status, undefined, "拒绝重放不得出现 SET 成功信封");
  assert.equal(errorOf(repeat.body).reason, "pin_already_configured");
  assert.equal(fixture.pinHash, `hash:${PIN}`, "PIN 保持原值");
  assert.equal(fixture.queries.filter((entry) => entry.sql.startsWith('UPDATE "zzsh_auth_admin"."session"')).length, 0);
});

test("PIN 首设：同标识同意图成功回放不重复写入，异标识 409，未带标识保持旧合同", async () => {
  const fixture = new SecurityCommandFixture();
  const first = await route(fixture, "/pin/set", { pin: PIN }, "idem_pin_set_1");
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "SET");
  assert.equal(first.body.commandId, "idem_pin_set_1");
  assert.equal(fixture.pinHash, `hash:${PIN}`);
  assert.equal(JSON.stringify(first.body).includes(PIN), false);

  const writes = fixture.queries.filter((entry) => entry.sql.startsWith('UPDATE "zzsh_auth_admin"."session"')).length;
  const repeat = await route(fixture, "/pin/set", { pin: PIN }, "idem_pin_set_1");
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.replayed, true);
  assert.equal(fixture.queries.filter((entry) => entry.sql.startsWith('UPDATE "zzsh_auth_admin"."session"')).length, writes,
    "同标识重复不得再次写入会话");

  const conflict = await route(fixture, "/pin/set", { pin: NEXT_PIN }, "idem_pin_set_1");
  assert.equal(conflict.status, 409);
  assert.equal(errorOf(conflict.body).code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(fixture.pinHash, `hash:${PIN}`);

  const legacy = new SecurityCommandFixture();
  const legacyResult = await route(legacy, "/pin/set", { pin: NEXT_PIN });
  assert.equal(legacyResult.status, 200);
  assert.equal(legacyResult.body.commandId, null, "未带命令标识时保持旧合同：无命令身份");
  assert.equal(legacyResult.body.receipt, null);
  assert.equal(legacy.pinHash, `hash:${NEXT_PIN}`);
});

// ---- F5 ----

test("F5 事务前快照未锁、事务内已锁时命令被拒（PIN 与插件同边界）", async () => {
  const fixture = new SecurityCommandFixture();
  fixture.snapshotLocked = false;
  fixture.locked = true;

  const pin = await route(fixture, "/pin/change", { currentPin: PIN, newPin: NEXT_PIN }, "idem_lock_toctou");
  assert.equal(pin.status, 423);
  assert.equal(errorOf(pin.body).reason, "session_locked");
  assert.equal(fixture.pinHash, null);

  const instance = await buildPlugin(fixture);
  await assert.rejects(
    () => instance.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_lock_toctou_plugin", locked: false }) as never),
    rejectsWith(423, "session_locked"),
  );
  assert.equal(fixture.backupValue, null, "锁态下不得重生成备份码");
});

test("F5 撤销/过期会话在事务内被拒，首登 PENDING 改密仍然合法", async () => {
  const revoked = new SecurityCommandFixture();
  revoked.sessionExists = false;
  assert.equal((await route(revoked, "/pin/set", { pin: PIN }, "idem_revoked")).status, 401);

  const expired = new SecurityCommandFixture();
  expired.sessionExpiresAt = new Date(Date.now() - 1000);
  assert.equal((await route(expired, "/pin/set", { pin: PIN }, "idem_expired_session")).status, 401);

  const frozen = new SecurityCommandFixture();
  frozen.status = "FROZEN";
  assert.equal((await route(frozen, "/pin/set", { pin: PIN }, "idem_frozen")).status, 401, "冻结在事务前门禁即拒绝");

  const firstLogin = new SecurityCommandFixture();
  firstLogin.status = "PENDING_ENROLLMENT";
  firstLogin.twoFactorEnabled = false;
  const client = await firstLogin.connect();
  await assert.doesNotReject(() => assertAdminCommandAuthorizedInTransaction(client, { userId: "admin_one", sessionId: "session_one" }, { allowPending: true }));
  await assert.rejects(
    () => assertAdminCommandAuthorizedInTransaction(client, { userId: "admin_one", sessionId: "session_one" }),
    rejectsWith(403, "additional_verification_required"),
    "PIN/备份码要求 ACTIVE + 2FA，首登态必须被拒",
  );
  client.release();
});

test("F5 回执存在不构成权限凭证：锁态下读取原结果同样被拒", async () => {
  const fixture = new SecurityCommandFixture();
  await route(fixture, "/pin/set", { pin: PIN }, "idem_read_locked");
  fixture.snapshotLocked = true;
  const read = await route(fixture, "/operation", { commandId: "idem_read_locked" });
  assert.equal(read.status, 423);
  fixture.snapshotLocked = false;
  assert.equal((await route(fixture, "/operation", { commandId: "idem_read_locked" })).body.status, "completed");
});

// ---- F2 ----

test("F2 真实 SDK 内部适配器：after 钩子在外层 COMMIT 前执行且只走事务 client", async () => {
  const fixture = new SecurityCommandFixture();
  const client = await fixture.connect();
  const hooks = adminSessionCreationHooks(client);
  const { createInternalAdapter } = await import("better-auth/db");
  const { runWithAdapter } = await import("@better-auth/core/context");

  const events: string[] = [];
  const adapter = {
    async create({ data }: { data: Record<string, unknown> }) { events.push("session-insert"); return { ...data }; },
    async findOne() { return null; },
    async findMany() { return []; },
    async update({ data }: { data: Record<string, unknown> }) { return { ...data }; },
    async updateMany() { return { matched: 0 }; },
    async delete() { return undefined; },
    async deleteMany() { return 0; },
  } as never;
  const internal = createInternalAdapter(adapter, {
    options: pluginOptions(fixture) as never,
    logger: loggerStub() as never,
    generateId: ({ model }: { model: string }) => `${model}_generated`,
    hooks: [{ source: "admin-security-command", hooks }],
  });

  events.push("outer-BEGIN");
  await runWithAdapter(adapter as never, async () => {
    await internal.createSession("admin_one", false);
    // runWithAdapter 下 SDK 的 after 钩子队列会立即执行；此处外层事务仍未 COMMIT。
    assert.equal(fixture.queries.filter((entry) => entry.sql.includes("last_full_authenticated_at")).length, 1,
      "after 钩子必须在外层 COMMIT 之前执行");
    events.push("outer-still-open");
  });
  events.push("outer-COMMIT");

  assert.deepEqual(events, ["outer-BEGIN", "session-insert", "outer-still-open", "outer-COMMIT"]);
  assert.equal(fixture.poolHookRuns, 0, "options.databaseHooks 走 pool，必须没有被执行");
  assert.equal(fixture.poolSecurityUpdates, 0, "认证时间刷新不得经 pool 连接");
  assert.ok(fixture.queries.some((entry) => entry.handle === "client" && entry.sql.includes("last_full_authenticated_at")),
    "认证时间刷新必须由当前事务 client 执行");
  client.release();
});

test("F2 真实事务内会话生成：撤销/写密码/签发/认证时间全在同一 client，过期仍是 7 天", async () => {
  const fixture = new SecurityCommandFixture();
  const instance = await buildPlugin(fixture);
  const ctx = pluginCtx(fixture, { commandId: "idem_change_ok" });
  ctx.body = { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD };

  const before = fixture.queries.length;
  const result = await instance.endpoints.adminSelfChangePassword(ctx as never) as unknown as Record<string, unknown>;
  assert.equal(result.status, true);
  assert.equal(result.action, "password.change");
  const executed = fixture.queries.slice(before);

  assert.ok(executed.some((entry) => entry.handle === "client" && /delete from "zzsh_auth_admin"\."session"/i.test(entry.sql)), "旧会话在同一事务内撤销");
  assert.ok(executed.some((entry) => entry.handle === "client" && /update "zzsh_auth_admin"\."account"/i.test(entry.sql)), "新密码哈希在同一事务内落库");
  assert.ok(executed.some((entry) => entry.handle === "client" && /insert into "zzsh_auth_admin"\."session"/i.test(entry.sql)), "新会话在同一事务内签发");
  assert.ok(executed.some((entry) => entry.handle === "client" && entry.sql.includes("last_full_authenticated_at")), "认证时间刷新走事务 client");
  assert.equal(fixture.poolSecurityUpdates, 0, "认证时间刷新没有绕回 pool");
  assert.equal(fixture.poolHookRuns, 0, "SDK pool 版 databaseHooks 没有被执行");
  assert.equal(fixture.accountPassword, `hash:${NEW_PASSWORD}`);

  const receipt = fixture.commands.get(fixture.key("admin_one", "idem_change_ok"));
  assert.equal(receipt?.status, "completed");
  assert.equal((receipt?.result as { sessionsRotated?: boolean })?.sessionsRotated, true);
  const lifetime = fixture.sessionExpiresAt.getTime() - Date.now();
  assert.ok(lifetime > 6.9 * 24 * 60 * 60 * 1000 && lifetime < 7.1 * 24 * 60 * 60 * 1000,
    `管理员新会话仍是 7 天，不复制用户端 30 天（实际 ${Math.round(lifetime / 3_600_000)}h）`);
});

// ---- F1 ----

test("F1 生成的备份码可被 SDK 对称解密还原，明文存储被 SDK 拒绝", async () => {
  const fixture = new SecurityCommandFixture();
  const instance = await buildPlugin(fixture);
  const { symmetricDecrypt } = await import("better-auth/crypto");

  const result = await instance.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_backup_first" }) as never) as unknown as Record<string, unknown>;
  assert.equal(result.status, true);
  const codes = result.backupCodes as string[];
  assert.equal(codes.length, 10);
  assert.match(codes[0]!, /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
  assert.ok(fixture.backupValue, "新码已落库");
  assert.equal(fixture.backupValue!.startsWith("["), false, "落库值不得是明文 JSON 数组");

  const decrypted = JSON.parse(await symmetricDecrypt({ key: SECRET, data: fixture.backupValue! })) as string[];
  assert.deepEqual(decrypted, codes, "SDK 默认加密合同：写进去的能被 SDK 解回同一批码");

  await assert.rejects(async () => { await symmetricDecrypt({ key: SECRET, data: JSON.stringify(codes) }); },
    "明文数组必须被 SDK 解码拒绝——不得把 realm 降级成明文");

  const firstStored = fixture.backupValue;
  const replay = await instance.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_backup_first" }) as never) as unknown as Record<string, unknown>;
  assert.equal(replay.replayed, true);
  assert.equal("backupCodes" in replay, false, "重放不再交付明文新码");
  assert.equal(fixture.backupValue, firstStored, "重放不再生成另一批码");
  assert.equal((await readBackupCodeGeneration(fixture.pool, "admin_one"))?.generation, 1);
});

test("F1 再次生成替换旧码并推进代次；错误密码拒绝重放保持 400 且不生成", async () => {
  const fixture = new SecurityCommandFixture();
  const instance = await buildPlugin(fixture);
  const { symmetricDecrypt } = await import("better-auth/crypto");

  const first = await instance.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_gen_a" }) as never) as unknown as Record<string, unknown>;
  const firstCodes = first.backupCodes as string[];
  assert.equal((first.receipt as { generation: number }).generation, 1);

  const second = await instance.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_gen_b" }) as never) as unknown as Record<string, unknown>;
  const secondCodes = second.backupCodes as string[];
  assert.equal((second.receipt as { generation: number }).generation, 2, "代次单调递增");
  assert.notDeepEqual(secondCodes, firstCodes);
  const stored = JSON.parse(await symmetricDecrypt({ key: SECRET, data: fixture.backupValue! })) as string[];
  assert.deepEqual(stored, secondCodes, "旧码已被新一代次替换");

  await assert.rejects(
    () => instance.endpoints.adminSelfGenerateBackupCodes(wrongPasswordCtx(fixture, "idem_gen_bad") as never),
    rejectsWith(400, "invalid_current_password"),
  );
  const before = fixture.backupValue;
  await assert.rejects(
    () => instance.endpoints.adminSelfGenerateBackupCodes(wrongPasswordCtx(fixture, "idem_gen_bad") as never),
    rejectsWith(400, "invalid_current_password"),
    "拒绝重放必须复现 400，而不是 status:true",
  );
  assert.equal(fixture.backupValue, before, "被拒绝的命令不生成新码");
  assert.equal((await readBackupCodeGeneration(fixture.pool, "admin_one"))?.generation, 2, "拒绝不推进代次");
});

test("N1 无key备份码writer同样要求新schema，缺表失败不能伪装成功", async () => {
  const fixture = new SecurityCommandFixture();
  fixture.generationTableExists = false;
  const plugin = await buildPlugin(fixture);
  const ctx = pluginCtx(fixture);
  ctx.headers.delete("idempotency-key");
  await assert.rejects(() => plugin.endpoints.adminSelfGenerateBackupCodes(ctx as never), { code: "42P01" });
  assert.equal(fixture.backupValue, null);
  assert.equal(fixture.commands.size, 0);
});

test("N2 审计失败回滚代次、加密码和命令回执，同key恢复后首次代次仍为1", async () => {
  const fixture = new SecurityCommandFixture();
  fixture.failAudit = true;
  const plugin = await buildPlugin(fixture);
  const run = () => plugin.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_rollback" }) as never);
  await assert.rejects(run, /Audit unavailable in fixture/);
  assert.equal(fixture.backupValue, null);
  assert.equal(fixture.generations.size, 0);
  assert.equal(fixture.commands.size, 0);
  fixture.failAudit = false;
  const done = await run() as unknown as { receipt: { generation: number } };
  assert.equal(done.receipt.generation, 1);
  assert.ok(fixture.queries.filter(entry => entry.sql.includes('"admin_backup_code_generation"')).every(entry => entry.handle === "client"));
});

test("N2 无key与带key生成共用递增代次，重放和历史回执清理不改变当前代次", async () => {
  const fixture = new SecurityCommandFixture();
  const plugin = await buildPlugin(fixture);
  const generate = async (commandId?: string) => {
    const ctx = pluginCtx(fixture, { commandId });
    if (!commandId) ctx.headers.delete("idempotency-key");
    return await plugin.endpoints.adminSelfGenerateBackupCodes(ctx as never) as unknown as {
      receipt: { generation: number; generationId: string }; replayed?: boolean;
    };
  };
  assert.equal((await generate()).receipt.generation, 1);
  assert.equal((await generate()).receipt.generation, 2);
  const third = await generate("idem_mixed");
  assert.equal(third.receipt.generation, 3);
  const stored = fixture.backupValue;
  const replay = await generate("idem_mixed");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, third.receipt);
  assert.equal(fixture.backupValue, stored);
  // Simulate future receipt-content compaction without deleting command identities.
  for (const row of fixture.commands.values()) row.result = null;
  assert.equal((await generate()).receipt.generation, 4);
  assert.equal((await readBackupCodeGeneration(fixture.pool, fixture.actorId))?.generation, 4);
});

test("N2 同毫秒或时钟倒退不影响备份码代次", async () => {
  const fixture = new SecurityCommandFixture();
  const plugin = await buildPlugin(fixture);
  const generate = async (commandId: string) => await plugin.endpoints.adminSelfGenerateBackupCodes(
    pluginCtx(fixture, { commandId }) as never,
  ) as unknown as { receipt: { generation: number } };
  assert.equal((await generate("z_first")).receipt.generation, 1);
  assert.equal((await generate("a_second")).receipt.generation, 2);
  const sameTime = new Date();
  for (const row of fixture.commands.values()) row.createdAt = sameTime;
  assert.equal((await generate("third")).receipt.generation, 3);
  fixture.commands.get(fixture.key(fixture.actorId, "third"))!.createdAt = new Date(sameTime.getTime() - 1000);
  assert.equal((await generate("fourth")).receipt.generation, 4);
});

test("retention_until是回执到期的权威，不由当前TTL重新推算", async () => {
  const fixture = new SecurityCommandFixture();
  const original = scope();
  await withClient(fixture, client => writeAdminSecurityCommandReceipt(client, original, {
    status: "completed", result: { pinConfigured: true },
  }));
  fixture.commands.get(fixture.key(original.adminUserId, original.commandId))!.retentionUntil = new Date(0);
  assert.equal((await readAdminSecurityCommandReceipt(fixture.pool, original.adminUserId, original.commandId)).status, "expired");
  await withClient(fixture, client => assert.rejects(claimAdminSecurityCommand(client, original), { status: 409 }));
});

test("F3 改密拒绝重放保持 400 且不改密码、不换发会话", async () => {
  const fixture = new SecurityCommandFixture();
  const instance = await buildPlugin(fixture);
  const run = () => {
    const ctx = pluginCtx(fixture, { commandId: "idem_change_bad" });
    ctx.body = { currentPassword: "wrong-fixture-password", newPassword: NEW_PASSWORD };
    return instance.endpoints.adminSelfChangePassword(ctx as never);
  };

  await assert.rejects(run(), rejectsWith(400, "invalid_current_password"));
  assert.equal(fixture.accountPassword, `hash:${CURRENT_PASSWORD}`, "密码未被改动");
  const sessionDeletes = () => fixture.queries.filter((entry) => /delete from "zzsh_auth_admin"\."session"/i.test(entry.sql)).length;
  assert.equal(sessionDeletes(), 0);

  await assert.rejects(run(), rejectsWith(400, "invalid_current_password"), "拒绝重放不得包装成 status:true");
  assert.equal(fixture.accountPassword, `hash:${CURRENT_PASSWORD}`);
  assert.equal(sessionDeletes(), 0, "拒绝重放不再次撤销会话");
});

// ---- F6 ----

test("F6 真实 SDK dispatch 抛出的项目错误被公共入口转成 409 合同，未知异常不泄露", async () => {
  const { dispatchAuthEndpoint } = await import("better-auth/api");
  const fixture = new SecurityCommandFixture();
  const instance = await buildPlugin(fixture);
  await instance.endpoints.adminSelfGenerateBackupCodes(pluginCtx(fixture, { commandId: "idem_reuse" }) as never);

  const dispatching = (input: unknown): Promise<Response> => {
    const payload = input as { body: unknown; headers: Headers };
    const ctx = pluginCtx(fixture, { commandId: "idem_reuse" });
    ctx.body = payload.body as Record<string, unknown>;
    return dispatchAuthEndpoint(instance.endpoints.adminSelfGenerateBackupCodes, {
      ...payload, context: ctx.context, asResponse: true,
    } as never) as unknown as Promise<Response>;
  };
  const interceptor = buildAdminSelfSecurityInterceptor(httpCommandStub(dispatching));

  const request = new Request(`${API_ORIGIN}/api/auth/admin/two-factor/generate-backup-codes`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "idem_reuse" },
    body: JSON.stringify({ password: "different-fixture-password" }),
  });
  const conflict = await interceptor(request, "req_conflict");
  assert.equal(conflict!.status, 409, "同标识不同意图必须是 409，不是 500");
  const payload = await conflict!.json() as { error: { code: string; message: string; reason?: string; requestId: string } };
  assert.equal(payload.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(payload.error.reason, "idempotency_key_reused");
  assert.equal(payload.error.requestId, "req_conflict");

  const leaking = buildAdminSelfSecurityInterceptor(httpCommandStub(async () => { throw new Error("driver exploded: password=hunter2"); }));
  const failure = await leaking(request, "req_unknown");
  assert.equal(failure!.status, 500);
  const failurePayload = await failure!.json() as { error: { code: string; message: string; reason?: string } };
  assert.equal(failurePayload.error.code, "INTERNAL_ERROR");
  assert.equal(failurePayload.error.message, "Internal server error");
  assert.equal(JSON.stringify(failurePayload).includes("hunter2"), false, "未知异常不得透出原始信息");
  assert.equal("reason" in failurePayload.error, false);
});

// ---- F7 ----

test("F7 成功正文不含 token/user，输出头不回显 set-auth-token，只保留 Set-Cookie", async () => {
  const fixture = new SecurityCommandFixture();
  const instance = await buildPlugin(fixture);
  const ctx = pluginCtx(fixture, { commandId: "idem_no_token" });
  ctx.body = { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD };
  const body = await instance.endpoints.adminSelfChangePassword(ctx as never) as unknown as Record<string, unknown>;
  assert.equal(body.status, true);
  assert.equal("token" in body, false, "源头正文不得包含原始会话 token");
  assert.equal("user" in body, false);
  assert.equal(typeof body.receipt, "object");

  // bearer 插件会把 session token 回显成 set-auth-token；拦截器必须裁掉，只留 Set-Cookie。
  const echoing = buildAdminSelfSecurityInterceptor(httpCommandStub(async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-auth-token": "raw-session-token",
          "set-cookie": "zzsh_admin.session_token=new-token; Path=/; HttpOnly",
          "cache-control": "no-store",
        },
      })));
  const request = new Request(`${API_ORIGIN}/api/auth/admin/change-password`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "idem_no_token" },
    body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const forwarded = await echoing(request, "req_f7");
  assert.equal(forwarded!.status, 200);
  assert.equal(forwarded!.headers.get("set-auth-token"), null, "输出头不得回显原始 token");
  assert.deepEqual(forwarded!.headers.getSetCookie(), ["zzsh_admin.session_token=new-token; Path=/; HttpOnly"], "Cookie 仍按既有机制交付");
  assert.equal(forwarded!.headers.get("cache-control"), "no-store");
  assert.equal(((await forwarded!.json()) as Record<string, unknown>).token, undefined);
});

// ---- 拦截器装配 ----

test("安全命令拦截只认两条本人命令路径，且不吞掉其他 SDK 路由", async () => {
  const seen: string[] = [];
  const interceptor = buildAdminSelfSecurityInterceptor(httpCommandStub(async () => { seen.push("called"); return new Response(JSON.stringify({ status: true }), { status: 200 }); }));
  const request = (path: string, method: string) => new Request(`${API_ORIGIN}${path}`, { method, ...(method === "GET" ? {} : { body: "{}" }) });
  assert.equal(await interceptor(request("/api/auth/admin/get-session", "GET"), "req"), null);
  assert.equal(await interceptor(request("/api/auth/admin/change-password", "GET"), "req"), null);
  assert.equal(await interceptor(request("/api/v1/admin/security/pin/set", "POST"), "req"), null);
  assert.equal(await interceptor(request("/api/auth/admin/two-factor/enable", "POST"), "req"), null);
  assert.equal(seen.length, 0, "非本人安全命令路径必须继续走原 SDK handler");

  assert.equal((await interceptor(request("/api/auth/admin/change-password", "POST"), "req"))!.status, 200);
  assert.deepEqual(seen, ["called"]);
});

test("SDK 原生错误报文只回受控原因，未知报文退化为通用拒绝", async () => {
  const controlled = buildAdminSelfSecurityInterceptor(httpCommandStub(async () => new Response(JSON.stringify({ message: "Current password is incorrect" }), { status: 400 })));
  const request = new Request(`${API_ORIGIN}/api/auth/admin/change-password`, { method: "POST", body: "{}" });
  const response = await controlled(request, "req_controlled");
  const payload = await response!.json() as { error: { code: string; message: string; reason?: string; requestId: string } };
  assert.equal(response!.status, 400);
  assert.equal(payload.error.code, "INVALID_ARGUMENT");
  assert.equal(payload.error.message, "Current password is incorrect");
  assert.equal(payload.error.reason, "invalid_current_password");
  assert.equal(payload.error.requestId, "req_controlled");

  const foreign = buildAdminSelfSecurityInterceptor(httpCommandStub(async () => new Response(JSON.stringify({ code: "SOME_SDK_CODE", message: "Internal adapter exploded: zzsh_auth_admin.account" }), { status: 400 })));
  const foreignPayload = await (await foreign(request, "req_foreign"))!.json() as { error: { message: string; reason?: string } };
  assert.equal(foreignPayload.error.message, "Authentication request rejected", "SDK 原始错误不得透出");
  assert.equal("reason" in foreignPayload.error, false);
});

test("未装配本人命令端点时拦截放行，不把路由变成 500", async () => {
  const interceptor = buildAdminSelfSecurityInterceptor({});
  const request = new Request(`${API_ORIGIN}/api/auth/admin/change-password`, { method: "POST", body: "{}" });
  assert.equal(await interceptor(request, "req"), null);
});

// ---- 读取端点 ----

test("POST /security/operation 只返回本人非敏感回执，未知与非法输入可区分", async () => {
  const fixture = new SecurityCommandFixture();
  await route(fixture, "/pin/set", { pin: PIN }, "idem_operation_1");

  const missing = await route(fixture, "/operation", { commandId: "idem_unknown" });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { commandId: "idem_unknown", status: "unconfirmed" });

  const confirmed = await route(fixture, "/operation", { commandId: "idem_operation_1" });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, "completed");
  assert.equal(confirmed.body.action, "pin.set");
  assert.equal(confirmed.body.targetSessionId, "session_one");
  assert.equal("fingerprint" in confirmed.body, false);
  assert.equal("target" in confirmed.body, false);

  const invalid = await route(fixture, "/operation", { commandId: "not a valid key" });
  assert.equal(invalid.status, 400);
  assert.equal(errorOf(invalid.body).code, "INVALID_ARGUMENT");

  assert.equal((await route(fixture, "/operation", { commandId: "idem_operation_1" }, undefined, "GET")).status, 404);

  const otherAdmin = new SecurityCommandFixture();
  otherAdmin.actorId = "admin_two";
  assert.equal((await route(otherAdmin, "/operation", { commandId: "idem_operation_1" })).body.status, "unconfirmed",
    "他人身份读不到本命令回执");
});

// ---- BFF ----

type CapturedAuthCall = { path: string; method: string; headers: Headers; body: unknown };

function bffOptions(fixture: SecurityCommandFixture) {
  const seen: CapturedAuthCall[] = [];
  const adminAuthHandler = async (request: Request): Promise<Response> => {
    seen.push({ path: new URL(request.url).pathname, method: request.method, headers: request.headers, body: await request.json().catch(() => undefined) });
    return new Response(JSON.stringify({ status: true, action: "password.change", receipt: { passwordChanged: true } }), {
      status: 200,
      headers: { "content-type": "application/json", "set-auth-token": "raw-session-token", "set-cookie": "zzsh_admin.session_token=new-token; Path=/; HttpOnly" },
    });
  };
  const options = {
    adminOrigin: ADMIN_ORIGIN,
    apiOrigin: API_ORIGIN,
    adminAuthHandler,
    adminSecurityOptions: securityOptions(fixture),
    supply: {},
    order: {},
  } as unknown as AdminBffOptions;
  return { options, seen };
}

async function bffRoute(options: AdminBffOptions, path: string, body?: unknown, headers: Record<string, string | string[]> = {}, method = "POST"): Promise<Routed> {
  const output = capture();
  await handleAdminBff(
    { method, url: path, originalUrl: path, body, headers: { origin: ADMIN_ORIGIN, ...headers } },
    output.response as never,
    options,
  );
  return output.result();
}

test("Admin BFF 传递 Idempotency-Key、保留 Set-Cookie、正文与输出头都不含原始 token", async () => {
  const fixture = new SecurityCommandFixture();
  const { options, seen } = bffOptions(fixture);
  const result = await bffRoute(options, "/auth/change-password",
    { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD },
    { "idempotency-key": "idem_bff_1", cookie: "zzsh_admin.session_token=abc" });
  assert.equal(result.status, 200);
  assert.equal(seen[0]?.path, "/api/auth/admin/change-password");
  assert.equal(seen[0]?.headers.get("idempotency-key"), "idem_bff_1");
  assert.equal(seen[0]?.headers.get("cookie"), "zzsh_admin.session_token=abc");
  assert.equal("token" in (result.body as Record<string, unknown>), false, "BFF 正文不得包含原始会话 token");
  assert.deepEqual(result.headers["Set-Cookie"], ["zzsh_admin.session_token=new-token; Path=/; HttpOnly"]);
  for (const name of Object.keys(result.headers)) {
    assert.equal(/token|authorization/i.test(name), false, `BFF 输出头不得回显 token：${name}`);
  }
});

test("Admin BFF 显式非法命令标识400且不转发，无key旧调用保持兼容", async () => {
  const fixture = new SecurityCommandFixture(), { options, seen } = bffOptions(fixture);
  for (const value of ["", "bad key!", "a".repeat(129), ["idem_one", "idem_two"], ["idem_one", "idem_one"]]) {
    const before = businessState(fixture);
    for (const path of ["/auth/change-password", "/auth/two-factor/generate-backup-codes"]) for (let attempt = 0; attempt < 2; attempt++) {
    const result = await bffRoute(options, path, { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD }, { "idempotency-key": value });
    assert.equal(result.status, 400); assert.equal(seen.length, 0); assert.deepEqual(businessState(fixture), before);
    }
  }
  assert.equal((await bffRoute(options, "/auth/change-password", { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD })).status, 200);
  assert.equal(seen[0]?.headers.get("idempotency-key"), null);
});

test("Admin BFF 暴露 POST /security/operation 并回读本人回执", async () => {
  const fixture = new SecurityCommandFixture();
  await route(fixture, "/pin/set", { pin: PIN }, "idem_bff_operation");
  const { options } = bffOptions(fixture);
  const read = await bffRoute(options, "/security/operation", { commandId: "idem_bff_operation" });
  assert.equal(read.status, 200);
  assert.equal(read.body.status, "completed");
  assert.equal(read.body.action, "pin.set");

  assert.equal((await bffRoute(options, "/security/operation", { commandId: "idem_bff_operation" }, {}, "GET")).status, 404);
  assert.equal((await bffRoute(options, "/security/operation", { commandId: "idem_not_present" })).body.status, "unconfirmed");
});

test("保留期常量与管理员会话绝对期限一致", () => {
  assert.equal(ADMIN_SECURITY_COMMAND_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

function businessState(fixture: SecurityCommandFixture) {
  return structuredClone({ password: fixture.accountPassword, pin: fixture.pinHash, failures: fixture.pinFailures, locked: fixture.locked, backup: fixture.backupValue, generation: [...fixture.generations], receipts: [...fixture.commands], audits: fixture.audits, sessionExists: fixture.sessionExists, sessionId: fixture.sessionId, expiresAt: fixture.sessionExpiresAt });
}

test("R2非法key两次拒绝：密码/备份码/PIN/计次/代次/回执在直接和BFF入口前后不变", async () => {
  for (const key of ["", " ", "invalid key", "a".repeat(129), "idem_one, idem_one", ["idem_one", "idem_one"]]) {
    for (const name of ["adminSelfChangePassword", "adminSelfGenerateBackupCodes"] as const) {
      const f = new SecurityCommandFixture(), plugin = await buildPlugin(f), before = businessState(f);
      for (let i = 0; i < 2; i++) {
        const ctx = pluginCtx(f); ctx.headers.delete("idempotency-key"); for (const value of Array.isArray(key) ? key : [key]) ctx.headers.append("idempotency-key", value);
        if (name === "adminSelfChangePassword") ctx.body = { currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD };
        let passwordWork = 0; ctx.context.password = { hash: async () => { passwordWork++; return "forbidden"; }, verify: async () => { passwordWork++; return true; } };
        await assert.rejects(async () => {
          if (name === "adminSelfChangePassword") await plugin.endpoints.adminSelfChangePassword(ctx as never);
          else await plugin.endpoints.adminSelfGenerateBackupCodes(ctx as never);
        }, rejectsWith(400, "invalid_idempotency_key"));
        assert.equal(passwordWork, 0); assert.deepEqual(businessState(f), before); assert.equal(f.queries.length, 0);
      }
    }
    for (const bff of [false, true]) for (const command of ["set", "change"]) {
      const f = new SecurityCommandFixture(); f.pinHash = command === "change" ? `hash:${PIN}` : null;
      const opts = securityOptions(f); let hashCalls = 0; opts.hashPassword = async () => { hashCalls++; return "forbidden"; };
      const before = businessState(f), body = command === "set" ? { pin: PIN } : { currentPin: "000000", newPin: NEXT_PIN };
      for (let i = 0; i < 2; i++) {
        const out = capture(), request = { method: "POST", url: `${bff ? "/api/bff/admin" : "/api/v1/admin"}/security/pin/${command}`, body, headers: { origin: ADMIN_ORIGIN, "idempotency-key": key } };
        if (bff) await handleAdminBff(request, out.response as never, { ...bffOptions(f).options, adminSecurityOptions: opts });
        else await handleAdminSecurity(request, out.response as never, opts);
        assert.equal(out.result().status, 400); assert.deepEqual(businessState(f), before); assert.equal(hashCalls, 0);
        assert(!f.queries.some(q => /^(BEGIN|INSERT|UPDATE|DELETE)/i.test(q.sql.trim())));
      }
    }
  }
});

test("R2有效key缺命令密钥必须503且不哈希/写入；真正无key旧PIN仍可用", async () => {
  for (const bff of [false, true]) for (const missing of [undefined, Buffer.alloc(0)]) for (const command of ["set", "change"]) {
    const f = new SecurityCommandFixture(); f.pinHash = command === "change" ? `hash:${PIN}` : null;
    const opts = { ...securityOptions(f), adminSecurityCommandKey: missing }, before = businessState(f); let hashes = 0;
    opts.hashPassword = async (value: string) => { hashes++; return `hash:${value}`; };
    const body = command === "set" ? { pin: PIN } : { currentPin: PIN, newPin: NEXT_PIN };
    const run = async (key?: string) => {
      const out = capture(), request = { method: "POST", url: `${bff ? "/api/bff/admin" : "/api/v1/admin"}/security/pin/${command}`, body, headers: { origin: ADMIN_ORIGIN, ...(key === undefined ? {} : { "idempotency-key": key }) } };
      if (bff) await handleAdminBff(request, out.response as never, { ...bffOptions(f).options, adminSecurityOptions: opts });
      else await handleAdminSecurity(request, out.response as never, opts);
      return out.result();
    };
    const rejected = await run("idem_requires_key"); assert.equal(rejected.status, 503); assert.deepEqual(businessState(f), before); assert.equal(hashes, 0);
    const legacy = await run(); assert.equal(legacy.status, 200); assert.equal(f.commands.size, 0); assert.equal(hashes, 1);
  }
});

test("R2备份码有效key同意图只执行一次，真正无key推进独立代次", async () => {
  const f = new SecurityCommandFixture(), plugin = await buildPlugin(f);
  const run = () => plugin.endpoints.adminSelfGenerateBackupCodes(pluginCtx(f, { commandId: "idem_valid_after_repair" }) as never) as unknown as Promise<Record<string, unknown>>;
  const first = await run(), stored = f.backupValue, replay = await run(); assert.equal(first.replayed, undefined); assert.equal(replay.replayed, true); assert.equal(f.backupValue, stored); assert.equal(f.commands.size, 1); assert.equal([...f.generations.values()][0]?.generation, 1);
  const legacy = pluginCtx(f); legacy.headers.delete("idempotency-key"); await plugin.endpoints.adminSelfGenerateBackupCodes(legacy as never); assert.equal([...f.generations.values()][0]?.generation, 2); assert.equal(f.commands.size, 1);
});

test("R1当前SDK真实HTTP router在改密/备份码原路径限流，直连/BFF均保留Retry-After且writer不再进入", async () => {
  const { betterAuth } = await import("better-auth"), { createAuthEndpoint } = await import("better-auth/api");
  for (const [index, publicPath, internalPath, allowed] of [[0, "/change-password", "/self-security/change-password", 3], [1, "/two-factor/generate-backup-codes", "/self-security/generate-backup-codes", 1]] as const) {
    const calls: string[] = [];
    const auth = betterAuth({
      baseURL: API_ORIGIN, basePath: "/api/auth/admin", secret: SECRET,
      trustedOrigins: [ADMIN_ORIGIN], logger: { disabled: true }, onAPIError: { throw: true },
      rateLimit: { enabled: true, window: 60, max: 1, storage: "memory" },
      plugins: [{ id: "offline-real-sdk-transaction-target", onRequest: adminSelfSecurityHttpRequest,
        endpoints: { transactionTarget: createAuthEndpoint(internalPath, { method: "POST" }, async ctx => { calls.push(internalPath); return ctx.json({ status: true }); }) },
      }],
    });
    const intercepted = buildAdminSelfSecurityInterceptor(auth);
    for (const bff of [false, true]) {
      const statuses: number[] = []; let retry: unknown;
      for (let i = 0; i <= allowed; i++) {
        if (bff) {
          const options = bffOptions(new SecurityCommandFixture()).options;
          options.adminAuthHandler = async req => (await intercepted(req, "req_sdk_bff"))!;
          const result = await bffRoute(options, "/auth" + publicPath, {}); statuses.push(result.status); retry = result.headers["retry-after"];
        } else {
          const request = new Request(API_ORIGIN + "/api/auth/admin" + publicPath, { method: "POST", headers: { "content-type": "application/json", origin: ADMIN_ORIGIN, "x-forwarded-for": "192.0.2." + (110 + index) }, body: "{}" });
          const result = (await intercepted(request, "req_sdk_direct"))!; statuses.push(result.status); retry = result.headers.get("retry-after");
        }
      }
      assert.deepEqual(statuses, [...Array(allowed).fill(200), 429]); assert(Number(retry) > 0); assert.equal(calls.length, bff ? allowed * 2 : allowed);
    }
    assert.equal(await intercepted(new Request(API_ORIGIN + "/api/auth/admin" + internalPath, { method: "POST", body: "{}" }), "req_internal"), null);
  }
});

test("R1真实SDK router抛出的受控项目错误保留状态/reason，未知错误不透出", async () => {
  const { betterAuth } = await import("better-auth"), { createAuthEndpoint } = await import("better-auth/api");
  const { AdminSecurityCommandError } = await import("../src/auth/admin-security-commands"), { API_V1_ERROR_CODES } = await import("../src/contracts/api-v1");
  for (const known of [true, false]) {
    const auth = betterAuth({ baseURL: API_ORIGIN, basePath: "/api/auth/admin", secret: SECRET, logger: { disabled: true }, onAPIError: { throw: true }, rateLimit: { enabled: false },
      plugins: [{ id: "offline-native-error", onRequest: adminSelfSecurityHttpRequest, endpoints: { target: createAuthEndpoint("/self-security/generate-backup-codes", { method: "POST" }, async () => {
        if (known) throw new AdminSecurityCommandError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Idempotency key was reused with a different request", "idempotency_key_reused");
        throw new Error("PRIVATE driver state");
      }) } }],
    });
    const request = new Request(API_ORIGIN + "/api/auth/admin/two-factor/generate-backup-codes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const response = (await buildAdminSelfSecurityInterceptor(auth)(request, "req_native_error"))!;
    const body = await response.json() as { error: { code: string; reason?: string; requestId: string } };
    assert.equal(response.status, known ? 409 : 500); assert.equal(body.error.requestId, "req_native_error");
    if (known) assert.equal(body.error.reason, "idempotency_key_reused");
    assert(!JSON.stringify(body).includes("PRIVATE"));
  }
});
