import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES, API_V1_TOKEN_PATTERN, type ApiV1ErrorCode } from "../contracts/api-v1";
import { SecurityApiError, withTransaction } from "./security-core";

/**
 * 管理员本人安全命令的命令身份与非敏感回执。
 *
 * 只覆盖本包的四条本人命令（改密、PIN首设、PIN更改、备份码重生成）：
 * PIN 作用于原会话，改密/备份码作用于管理员凭据，回执里用 target 显式区分。
 *
 * 存储用专用表 `zzsh_iam.admin_security_command`（见 schema-proposal.sql，
 * 迁移号由总 Master 分配，本包不自行占号、不执行 DDL）。
 * 不能复用 `zzsh_auth_admin.verification` 承载本用途：该表按 `expiresAt` 被
 * SDK 的 `findVerificationValue` 清理（better-auth 1.7.3
 * `db/internal-adapter.mjs` 在 `options.verification.disableCleanup` 未设置时执行
 * `expiresAt < now` 的 deleteMany），一旦过期回执被删，同一命令标识就会重新变成
 * "从未执行"，违背"过期不重新执行"。命令身份必须比保留期活得久，且回执内容有明确
 * 保留期，这两件事在 verification 的列语义里无法同时表达。
 *
 * 请求一致性指纹是带密钥的 HMAC：低熵 PIN 即使回执行泄露也无法离线枚举。
 * 密钥来源是现有 admin realm 的 AUTH_ADMIN_SECRET，经 HKDF 派生用途子密钥，
 * 不新增环境变量、不改动任何 secret；轮换该 secret 会使历史指纹不再匹配，
 * 同标识重放按冲突拒绝（不会重新执行），回执读取本身不受影响。
 */
export const ADMIN_SECURITY_COMMAND_ACTIONS = [
  "password.change",
  "pin.set",
  "pin.change",
  "backup-codes.generate",
] as const;

export type AdminSecurityCommandAction = (typeof ADMIN_SECURITY_COMMAND_ACTIONS)[number];

export type AdminSecurityCommandTargetKind = "session" | "credential";

/** 回执可读保留期，与管理员会话绝对期限一致：7 天。 */
export const ADMIN_SECURITY_COMMAND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const HKDF_SALT = "zzsh:admin-security-command:v1";
const HKDF_INFO = "request-fingerprint";
const COMMAND_ID_PATTERN = new RegExp(`^${API_V1_TOKEN_PATTERN.slice(1, -1)}$`);

/** 拒绝的完整合同信封；重放必须原样复现，不得包装成成功。 */
export type AdminSecurityCommandRejection = {
  status: number;
  code: ApiV1ErrorCode;
  message: string;
  reason?: string;
};

export type AdminSecurityCommandReceipt = {
  version: 1;
  commandId: string;
  action: AdminSecurityCommandAction;
  adminUserId: string;
  target: { kind: AdminSecurityCommandTargetKind; id: string };
  fingerprint: string;
  status: "completed" | "rejected";
  reason?: string;
  result?: Record<string, unknown>;
  rejection?: AdminSecurityCommandRejection;
  createdAt: string;
  requestId?: string;
};

/** 已知项目错误；SDK dispatch 不识别它，因此由 realm 公共入口转换为合同错误。 */
export class AdminSecurityCommandError extends SecurityApiError {
  constructor(
    status: number,
    code: ApiV1ErrorCode,
    message: string,
    readonly reason?: string,
  ) {
    super(status, code, message);
  }
}

/** 回执作用域串行化键；同一 (管理员, 命令标识) 的并发请求在此排队。 */
export function adminSecurityCommandScopeKey(adminUserId: string, commandId: string): string {
  return JSON.stringify(["admin-security-command", adminUserId, commandId]);
}

/** Only an absent header keeps legacy behavior; a supplied invalid key must never execute. */
export function adminSecurityCommandId(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
): string | undefined {
  if (!headers) return undefined;
  let raw: string | string[] | undefined;
  if (typeof (headers as Headers).get === "function") raw = (headers as Headers).get("idempotency-key") ?? undefined;
  else {
    const values = Object.entries(headers).filter(([name, value]) => name.toLowerCase() === "idempotency-key" && value !== undefined);
    if (values.length > 1) throw new AdminSecurityCommandError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Idempotency key is invalid", "invalid_idempotency_key");
    raw = values[0]?.[1];
  }
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128 || !COMMAND_ID_PATTERN.test(raw)) {
    throw new AdminSecurityCommandError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Idempotency key is invalid", "invalid_idempotency_key");
  }
  return raw;
}

export function deriveAdminSecurityCommandKey(adminSecret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(adminSecret, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32),
  );
}

/** 指纹输入包含秘密字段，但只以 HMAC 输出落库；不同 action/target 自然区分意图。 */
export function adminSecurityCommandFingerprint(commandKey: Buffer, input: readonly unknown[]): string {
  return createHmac("sha256", commandKey).update(JSON.stringify(input)).digest("hex");
}

export type AdminSecurityCommandScope = {
  adminUserId: string;
  commandId: string;
  action: AdminSecurityCommandAction;
  target: { kind: AdminSecurityCommandTargetKind; id: string };
  fingerprint: string;
};

export type AdminSecurityCommandClaim =
  | { mode: "execute" }
  | { mode: "replay"; receipt: AdminSecurityCommandReceipt };

type CommandRow = {
  action: string;
  targetKind: string;
  targetId: string;
  fingerprint: string;
  status: string;
  reason: string | null;
  result: unknown;
  rejection: unknown;
  createdAt: Date;
  retentionUntil: Date;
  requestId: string | null;
};

function isAction(value: unknown): value is AdminSecurityCommandAction {
  return typeof value === "string" && (ADMIN_SECURITY_COMMAND_ACTIONS as readonly string[]).includes(value);
}

function isTargetKind(value: unknown): value is AdminSecurityCommandTargetKind {
  return value === "session" || value === "credential";
}

function rowToReceipt(row: CommandRow, adminUserId: string, commandId: string): AdminSecurityCommandReceipt | null {
  if (!isAction(row.action) || !isTargetKind(row.targetKind)) return null;
  if (row.status !== "completed" && row.status !== "rejected") return null;
  const rejection = row.rejection as AdminSecurityCommandRejection | null | undefined;
  return {
    version: 1,
    commandId,
    action: row.action,
    adminUserId,
    target: { kind: row.targetKind, id: row.targetId },
    fingerprint: row.fingerprint,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.result && typeof row.result === "object" ? { result: row.result as Record<string, unknown> } : {}),
    ...(rejection && typeof rejection === "object" ? { rejection } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.requestId ? { requestId: row.requestId } : {}),
  };
}

const COMMAND_SELECT = `SELECT "action", "target_kind" AS "targetKind", "target_id" AS "targetId",
        "fingerprint", "status", "reason", "result", "rejection",
        "created_at" AS "createdAt", "retention_until" AS "retentionUntil", "request_id" AS "requestId"
   FROM "zzsh_iam"."admin_security_command"`;

/**
 * 命令范围 advisory lock 串行化同一 (管理员, 命令标识) 的并发请求：
 * 后到请求必须等到先到事务结束，因此要么看到回执并回放，要么看到新的真实状态。
 * 过保留期的行**保留**为防重放身份：只拒绝重新执行，绝不让旧 key 再次变成可执行。
 */
export async function claimAdminSecurityCommand(
  client: PoolClient,
  scope: AdminSecurityCommandScope,
): Promise<AdminSecurityCommandClaim> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [adminSecurityCommandScopeKey(scope.adminUserId, scope.commandId)]);
  // 不取 FOR UPDATE：命令表 runtime 只有 SELECT/INSERT（行锁需要 UPDATE 权限）。
  // 同一 (管理员, 命令标识) 的 claim/重放/拒绝回执都先取同一把 advisory 事务锁，
  // 插入再由 PK 兜底去重，因此读取不加行锁不引入竞态。
  const row = (await client.query<CommandRow>(
    `${COMMAND_SELECT} WHERE "admin_user_id" = $1 AND "command_id" = $2`,
    [scope.adminUserId, scope.commandId],
  )).rows[0];
  if (!row) return { mode: "execute" };
  const receipt = rowToReceipt(row, scope.adminUserId, scope.commandId);
  const expired = row.retentionUntil.getTime() <= Date.now();
  if (!receipt || receipt.action !== scope.action || receipt.fingerprint !== scope.fingerprint || expired) {
    throw new AdminSecurityCommandError(
      409,
      API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      "Idempotency key was reused with a different request",
      "idempotency_key_reused",
    );
  }
  return { mode: "replay", receipt };
}

export async function writeAdminSecurityCommandReceipt(
  client: PoolClient,
  scope: AdminSecurityCommandScope,
  outcome:
    | { status: "completed"; result: Record<string, unknown> }
    | { status: "rejected"; reason?: string; rejection: AdminSecurityCommandRejection },
  requestId?: string,
): Promise<AdminSecurityCommandReceipt> {
  const now = new Date();
  const receipt: AdminSecurityCommandReceipt = {
    version: 1,
    commandId: scope.commandId,
    action: scope.action,
    adminUserId: scope.adminUserId,
    target: { kind: scope.target.kind, id: scope.target.id },
    fingerprint: scope.fingerprint,
    status: outcome.status,
    ...(outcome.status === "rejected"
      ? { ...(outcome.reason ? { reason: outcome.reason } : {}), rejection: outcome.rejection }
      : { result: outcome.result }),
    createdAt: now.toISOString(),
    ...(requestId ? { requestId } : {}),
  };
  // 身份行永不按时间删除：过期由 retention_until 判定，命令身份永久保留用于防重放。
  await client.query(
    `INSERT INTO "zzsh_iam"."admin_security_command"
       ("admin_user_id", "command_id", "action", "target_kind", "target_id", "fingerprint",
        "status", "reason", "result", "rejection", "request_id", "created_at", "retention_until")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13)`,
    [
      scope.adminUserId,
      scope.commandId,
      scope.action,
      scope.target.kind,
      scope.target.id,
      scope.fingerprint,
      receipt.status,
      receipt.reason ?? null,
      receipt.result ? JSON.stringify(receipt.result) : null,
      receipt.rejection ? JSON.stringify(receipt.rejection) : null,
      requestId ?? null,
      now,
      new Date(now.getTime() + ADMIN_SECURITY_COMMAND_TTL_MS),
    ],
  );
  return receipt;
}

/**
 * 拒绝回执在主事务结束之后单独提交：主事务回滚时业务没有落地，
 * 但客户端若丢了响应，仍能把"明确拒绝"与"未能确认"区分开。
 * 写入失败不得覆盖原错误，读取侧会退回 unconfirmed。
 */
export async function recordAdminSecurityCommandRejection(
  pool: Pool,
  scope: AdminSecurityCommandScope,
  rejection: AdminSecurityCommandRejection,
  requestId?: string,
  audit?: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  try {
    return await withTransaction(pool, async (client) => {
      const claim = await claimAdminSecurityCommand(client, scope);
      if (claim.mode === "replay") return false;
      await writeAdminSecurityCommandReceipt(client, scope, { status: "rejected", reason: rejection.reason, rejection }, requestId);
      if (audit) await audit(client);
      return true;
    });
  } catch {
    return false;
  }
}

export type AdminSecurityCommandReadResult = {
  commandId: string;
  status: "completed" | "rejected" | "unconfirmed" | "expired";
  action?: AdminSecurityCommandAction;
  targetKind?: AdminSecurityCommandTargetKind;
  targetSessionId?: string;
  reason?: string;
  result?: Record<string, unknown>;
  createdAt?: string;
  expiresAt?: string;
};

/**
 * 只按调用方自己的管理员身份读取；仅知道命令标识不能查询他人状态，也不会返回指纹。
 * 回执存在不是权限凭证——调用方仍须先通过会话/账号门禁。
 */
export async function readAdminSecurityCommandReceipt(
  pool: Pool,
  adminUserId: string,
  commandId: string,
): Promise<AdminSecurityCommandReadResult> {
  return withTransaction(pool, async (client) => {
    // 与写入共用命令范围锁：正在提交的命令先落库，读取不会把它误报成未确认。
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [adminSecurityCommandScopeKey(adminUserId, commandId)]);
    const row = (await client.query<CommandRow>(
      `${COMMAND_SELECT} WHERE "admin_user_id" = $1 AND "command_id" = $2`,
      [adminUserId, commandId],
    )).rows[0];
    if (!row) return { commandId, status: "unconfirmed" as const };
    const createdAt = row.createdAt.toISOString();
    const expiresAt = row.retentionUntil.toISOString();
    const receipt = rowToReceipt(row, adminUserId, commandId);
    if (!receipt) return { commandId, status: "expired" as const, createdAt, expiresAt };
    if (row.retentionUntil.getTime() <= Date.now()) {
      return { commandId, status: "expired" as const, action: receipt.action, createdAt, expiresAt };
    }
    return {
      commandId,
      status: receipt.status,
      action: receipt.action,
      targetKind: receipt.target.kind,
      ...(receipt.target.kind === "session" ? { targetSessionId: receipt.target.id } : {}),
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(receipt.result ? { result: receipt.result } : {}),
      createdAt,
      expiresAt,
    };
  });
}

export type BackupCodeGeneration = { generation: number; generationId: string; generatedAt: string };

type BackupCodeGenerationRow = Omit<BackupCodeGeneration, "generatedAt"> & { generatedAt: Date };

/**
 * 当前生成代次独立于命令回执：无key调用也推进，历史回执内容清理不影响它。
 * 仅表示最近一次生成，不表示该批备份码尚有剩余或仍全部有效。
 */
export async function readBackupCodeGeneration(client: Pool | PoolClient, adminUserId: string): Promise<BackupCodeGeneration | null> {
  const row = (await client.query<BackupCodeGenerationRow>(
    `SELECT "generation", "generation_id" AS "generationId", "generated_at" AS "generatedAt"
       FROM "zzsh_iam"."admin_backup_code_generation" WHERE "admin_user_id" = $1`,
    [adminUserId],
  )).rows[0];
  return row ? { ...row, generatedAt: row.generatedAt.toISOString() } : null;
}

/** 调用方持有twoFactor行锁；代次、加密码、审计及可选回执须在同一事务提交。 */
export async function nextBackupCodeGeneration(client: PoolClient, adminUserId: string): Promise<BackupCodeGeneration> {
  const row = (await client.query<BackupCodeGenerationRow>(
    `INSERT INTO "zzsh_iam"."admin_backup_code_generation" AS current_generation
       ("admin_user_id", "generation", "generation_id", "generated_at")
     VALUES ($1, 1, $2, clock_timestamp())
     ON CONFLICT ("admin_user_id") DO UPDATE
       SET "generation" = current_generation."generation" + 1,
           "generation_id" = EXCLUDED."generation_id", "generated_at" = EXCLUDED."generated_at"
     RETURNING "generation", "generation_id" AS "generationId", "generated_at" AS "generatedAt"`,
    [adminUserId, `bcgen_${randomUUID().replaceAll("-", "")}`],
  )).rows[0];
  if (!row) throw new Error("Backup code generation was not recorded");
  return { ...row, generatedAt: row.generatedAt.toISOString() };
}
