import { formatDate } from "../../api.ts";

export type SecurityAction = "password.change" | "pin.set" | "pin.change" | "backup-codes.generate";
export type SecurityTargetKind = "session" | "credential";

export type SecurityCommandError = { status: number; code: string; reason?: string };

export type OperationReadResult = {
  commandId: string;
  status: "completed" | "rejected" | "unconfirmed" | "expired";
  action?: SecurityAction;
  targetKind?: SecurityTargetKind;
  targetSessionId?: string;
  reason?: string;
  result?: Record<string, unknown>;
  createdAt?: string;
  expiresAt?: string;
};

export type PasswordChangeReceipt = {
  passwordChanged?: boolean;
  sessionsRotated?: boolean;
  revokedSessionCount?: number;
  newSessionId?: string;
};
export type PinReceipt = { pinConfigured?: boolean; pinChanged?: boolean; sessionId?: string };
export type BackupCodesReceipt = {
  generated?: boolean;
  generation?: number;
  generationId?: string;
  generatedAt?: string;
  codeCount?: number;
};

/** 适配器直接透传后端 DTO（合同字段名）；是否构成可信成功由组件内 verifyCommandSuccess 判定。 */
export type PasswordChangeEnvelope = { commandId?: string | null; receipt?: PasswordChangeReceipt };
export type PinEnvelope = { commandId?: string | null; receipt?: PinReceipt };
export type BackupCodesEnvelope = { commandId?: string | null; backupCodes?: string[]; receipt?: BackupCodesReceipt };

export type SecurityCommands = {
  changePassword: (input: { commandId: string; currentPassword: string; newPassword: string }) => Promise<PasswordChangeEnvelope>;
  setPin: (input: { commandId: string; pin: string }) => Promise<PinEnvelope>;
  changePin: (input: { commandId: string; currentPin: string; newPin: string }) => Promise<PinEnvelope>;
  generateBackupCodes: (input: { commandId: string; password: string }) => Promise<BackupCodesEnvelope>;
  readOperation: (input: { commandId: string }) => Promise<OperationReadResult>;
};

export type AccountStatus = "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";

export type SecurityFactsInput = {
  accountStatus: AccountStatus;
  twoFactorEnabled: boolean | null;
  session: { id: string; locked: boolean; pinConfigured: boolean };
};

export type PendingOutcome = "unknown" | "completed" | "unconfirmed" | "expired";

export type PendingRecord = {
  adminUserId: string;
  action: SecurityAction;
  commandId: string;
  targetKind: SecurityTargetKind;
  targetSessionId?: string;
  createdAt: string;
  updatedAt: string;
  outcome: PendingOutcome;
  /** 是否已经发出过请求（首次明确拒绝 vs 未知后的授权失败需要区分）。 */
  dispatched?: boolean;
  /** 仅备份码生成：是否已在本机由用户确认保存。 */
  delivered?: boolean;
  /** 用户已隐藏提醒；记录与未决责任仍在，不等同核清。 */
  dismissed?: boolean;
  /** 仅非敏感回执白名单子集；绝不包含密码/PIN/备份码明文。 */
  result?: Record<string, unknown>;
};

export const SECURITY_PENDING_KEY = "zzsh-admin-security-pending";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const IDLE_CHOICES = [5, 15, 30, 60] as const;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_SUBSET_KEYS = ["generation", "generatedAt", "codeCount"] as const;

const ACTION_NAMES: Record<SecurityAction, string> = {
  "password.change": "修改登录密码",
  "pin.set": "设置会话 PIN",
  "pin.change": "更改会话 PIN",
  "backup-codes.generate": "重新生成备份码",
};

export function isSecurityAction(value: unknown): value is SecurityAction {
  return typeof value === "string" && value in ACTION_NAMES;
}

export function actionLabel(action: SecurityAction): string {
  return ACTION_NAMES[action];
}

export function normalizeIdleMinutes(value: number): number {
  return (IDLE_CHOICES as readonly number[]).includes(value) ? value : 15;
}

export function makeSecurityCommandId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `idem_${random.replaceAll("-", "")}`;
}

export function asCommandError(failure: unknown): SecurityCommandError {
  if (failure && typeof failure === "object") {
    const candidate = failure as { status?: unknown; code?: unknown; reason?: unknown };
    if (typeof candidate.status === "number" && typeof candidate.code === "string") {
      return {
        status: candidate.status,
        code: candidate.code,
        ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
      };
    }
  }
  return { status: 0, code: "NETWORK_ERROR" };
}

/** 结果未知：网络中断或服务端未给受控结果（5xx）。绝不按拒绝处理，也不自动换 key 重发。 */
export function isUnknownOutcome(error: SecurityCommandError): boolean {
  return error.status === 0 || error.status >= 500;
}

const REASON_COPY: Record<string, string> = {
  password_too_short: `新密码至少需要 ${PASSWORD_MIN_LENGTH} 位。`,
  password_too_long: `新密码不能超过 ${PASSWORD_MAX_LENGTH} 位。`,
  same_password: "新密码不能与当前密码相同。",
  invalid_current_password: "当前密码不正确，请重新输入。",
  credential_missing: "当前账号缺少密码凭据，无法在此修改；请联系维护人员。",
  account_unavailable: "账号当前不可用（已冻结或停用），无法执行安全操作。",
  authentication_required: "登录会话已失效，请重新登录后再操作。",
  session_locked: "当前会话已锁定，请先解锁（PIN 或完整重新认证）再操作。",
  additional_verification_required: "需要先完成身份验证器绑定与启用。",
  pin_already_configured: "当前会话已经配置了 PIN；如需更换请使用“更改 PIN”。",
  pin_not_configured: "当前会话尚未配置 PIN；请先设置 PIN。",
  invalid_pin: "当前 PIN 不正确。本次失败可能已计入尝试次数；请确认后重试，或使用完整重新认证重设 PIN。",
  pin_attempt_limit: "PIN 连续错误达到上限，当前会话已锁定；请使用完整重新认证（密码＋验证器）解锁并重设 PIN。",
  two_factor_required: "需要先启用身份验证器才能管理备份码。",
  password_required: "请输入当前登录密码以继续。",
  backup_codes_unavailable: "当前账号没有可用的双因素绑定，无法生成备份码。",
  idempotency_key_reused: "本次操作标识已用于不同内容的请求；请重新发起一次新的操作。",
  rejected: "原命令被拒绝。",
};

export function describeCommandError(action: SecurityAction, error: SecurityCommandError): string {
  const reasonCopy = error.reason ? REASON_COPY[error.reason] : undefined;
  if (reasonCopy) return reasonCopy;
  if (isUnknownOutcome(error)) return "网络或服务中断，未能收到明确结果。";
  if (error.status === 400) return "请求内容不符合要求，请检查输入后重试。";
  if (error.status === 401) return "登录会话已失效，请重新登录后再操作。";
  if (error.status === 403) return action === "pin.set" ? "需要先完成身份验证器绑定与启用。" : "当前账号或安全条件不允许此操作。";
  if (error.status === 409) return "当前安全状态不允许此操作，请刷新状态后重试。";
  if (error.status === 423) return "当前会话已锁定，请先解锁（PIN 或完整重新认证）再操作。";
  return "操作未完成，请检查输入或刷新页面后重试。";
}

export function describeReadError(error: SecurityCommandError): string {
  const reasonCopy = error.reason ? REASON_COPY[error.reason] : undefined;
  if (reasonCopy) return reasonCopy;
  if (isUnknownOutcome(error)) return "网络中断，无法读取结果，请稍后重试。";
  if (error.status === 400) return "命令标识无效，无法读取结果。";
  if (error.status === 401) return "读取被拒绝：会话已失效，请重新登录后再核对。";
  if (error.status === 403) return "读取被拒绝：当前账号或安全条件不允许读取该结果。";
  if (error.status === 423) return "当前会话已锁定，解锁后再核对结果。";
  return "无法读取结果，请稍后重试。";
}

export type PasswordChangeInput = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export function validatePasswordChange(input: PasswordChangeInput): Partial<Record<keyof PasswordChangeInput, string>> {
  const errors: Partial<Record<keyof PasswordChangeInput, string>> = {};
  if (!input.currentPassword) errors.currentPassword = "请输入当前密码。";
  if (!input.newPassword) errors.newPassword = "请输入新密码。";
  else if (input.newPassword.length < PASSWORD_MIN_LENGTH) errors.newPassword = `新密码至少 ${PASSWORD_MIN_LENGTH} 位。`;
  else if (input.newPassword.length > PASSWORD_MAX_LENGTH) errors.newPassword = `新密码不能超过 ${PASSWORD_MAX_LENGTH} 位。`;
  else if (input.currentPassword && input.newPassword === input.currentPassword) errors.newPassword = "新密码不能与当前密码相同。";
  if (!errors.newPassword && input.confirmPassword !== input.newPassword) errors.confirmPassword = "两次输入的新密码不一致。";
  return errors;
}

export function validatePin(pin: string): string | undefined {
  if (!/^\d{6}$/.test(pin)) return "请输入 6 位数字 PIN。";
  return undefined;
}

export function validateBackupPassword(password: string): string | undefined {
  if (!password) return "请输入当前登录密码。";
  return undefined;
}

/** 成功信封的本地校验：本次 key 必须回显一致；各操作按后端真实 DTO 检查最小必需字段。 */
export function verifyCommandSuccess(
  action: SecurityAction,
  payload: unknown,
  commandId: string,
  target: { sessionId?: string } = {},
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const envelope = payload as { commandId?: unknown; receipt?: unknown; backupCodes?: unknown };
  if (envelope.commandId !== commandId) return false;
  const receipt = envelope.receipt && typeof envelope.receipt === "object" ? (envelope.receipt as Record<string, unknown>) : undefined;
  if (!receipt) return false;
  if (action === "password.change") {
    return (
      receipt.passwordChanged === true &&
      receipt.sessionsRotated === true &&
      typeof receipt.revokedSessionCount === "number" &&
      noneEmpty(receipt.newSessionId)
    );
  }
  if (action === "pin.set") {
    return receipt.pinConfigured === true && noneEmpty(receipt.sessionId) && receipt.sessionId === target.sessionId;
  }
  if (action === "pin.change") {
    return receipt.pinChanged === true && noneEmpty(receipt.sessionId) && receipt.sessionId === target.sessionId;
  }
  if (!Array.isArray(envelope.backupCodes) || envelope.backupCodes.length === 0) return false;
  if (!envelope.backupCodes.every((code) => typeof code === "string" && code.length > 0)) return false;
  return (
    receipt.generated === true &&
    typeof receipt.generation === "number" &&
    noneEmpty(receipt.generationId) &&
    validDateString(receipt.generatedAt) &&
    typeof receipt.codeCount === "number" &&
    receipt.codeCount === envelope.backupCodes.length
  );
}

function noneEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validDateString(value: unknown): boolean {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

/** 只读回执的完整性/绑定校验：key、action、targetKind、原 targetSessionId、状态枚举与最小终态正文。 */
export function validateOperationResult(
  result: unknown,
  record: Pick<PendingRecord, "commandId" | "action" | "targetKind" | "targetSessionId">,
): { ok: true } | { ok: false; message: string } {
  if (!result || typeof result !== "object") return { ok: false, message: "回执为空或格式错误，无法确认结果。" };
  const payload = result as OperationReadResult;
  if (payload.commandId !== record.commandId) return { ok: false, message: "回执的命令标识与本次请求不一致，无法确认结果。" };
  if (payload.status !== "completed" && payload.status !== "rejected" && payload.status !== "unconfirmed" && payload.status !== "expired") {
    return { ok: false, message: "回执状态未知，无法确认结果。" };
  }
  if (payload.createdAt !== undefined && !validDateString(payload.createdAt)) {
    return { ok: false, message: "回执时间格式错误，无法确认结果。" };
  }
  if (payload.status === "unconfirmed") return { ok: true };

  const comparable = payload.status === "completed" || payload.status === "rejected";
  if (comparable) {
    if (!isSecurityAction(payload.action) || payload.action !== record.action) {
      return { ok: false, message: "回执记录的操作与本机待核记录不一致，无法确认结果。" };
    }
    if (payload.targetKind !== record.targetKind) {
      return { ok: false, message: "回执记录的作用对象类型与本机待核记录不一致，无法确认结果。" };
    }
    if (record.targetKind === "session") {
      if (!noneEmpty(payload.targetSessionId) || payload.targetSessionId !== record.targetSessionId) {
        return { ok: false, message: "回执记录的作用会话与本机待核记录不一致，无法确认结果。" };
      }
    } else if (payload.targetSessionId !== undefined) {
      return { ok: false, message: "回执记录带有不属于管理员凭据的作用会话，无法确认结果。" };
    }
  } else if (payload.action !== undefined) {
    if (!isSecurityAction(payload.action) || payload.action !== record.action) {
      return { ok: false, message: "回执记录的操作与本机待核记录不一致，无法确认结果。" };
    }
    if (payload.targetKind !== undefined && payload.targetKind !== record.targetKind) {
      return { ok: false, message: "回执记录的作用对象类型与本机待核记录不一致，无法确认结果。" };
    }
    if (
      payload.targetKind === "session" &&
      payload.targetSessionId !== undefined &&
      payload.targetSessionId !== record.targetSessionId
    ) {
      return { ok: false, message: "回执记录的作用会话与本机待核记录不一致，无法确认结果。" };
    }
  }

  if (payload.status === "rejected") {
    if (!noneEmpty(payload.reason)) return { ok: false, message: "拒绝回执缺少受控原因，无法确认结果。" };
    return { ok: true };
  }
  if (payload.status === "expired") return { ok: true };

  const resultBody = payload.result as Record<string, unknown> | undefined;
  if (!resultBody || typeof resultBody !== "object") return { ok: false, message: "完成回执缺少结果内容，无法确认结果。" };
  if (payload.action === "password.change") {
    if (
      resultBody.passwordChanged !== true ||
      resultBody.sessionsRotated !== true ||
      typeof resultBody.revokedSessionCount !== "number" ||
      !noneEmpty(resultBody.newSessionId)
    ) {
      return { ok: false, message: "完成回执与改密结果不符，无法确认结果。" };
    }
  }
  if (payload.action === "pin.set") {
    if (resultBody.pinConfigured !== true || !noneEmpty(resultBody.sessionId) || resultBody.sessionId !== payload.targetSessionId) {
      return { ok: false, message: "完成回执的 PIN 会话与外层作用会话不一致，无法确认结果。" };
    }
  }
  if (payload.action === "pin.change") {
    if (resultBody.pinChanged !== true || !noneEmpty(resultBody.sessionId) || resultBody.sessionId !== payload.targetSessionId) {
      return { ok: false, message: "完成回执的 PIN 会话与外层作用会话不一致，无法确认结果。" };
    }
  }
  if (payload.action === "backup-codes.generate") {
    if (
      resultBody.generated !== true ||
      typeof resultBody.generation !== "number" ||
      !noneEmpty(resultBody.generationId) ||
      !validDateString(resultBody.generatedAt) ||
      typeof resultBody.codeCount !== "number"
    ) {
      return { ok: false, message: "完成回执与备份码生成结果不符，无法确认结果。" };
    }
  }
  return { ok: true };
}

export function passwordSuccessLines(receipt?: PasswordChangeReceipt): string[] {
  const lines = ["登录密码已更新，其他设备的旧登录会话已全部撤销。"];
  if (typeof receipt?.revokedSessionCount === "number") lines.push(`本次撤销旧会话 ${receipt.revokedSessionCount} 个。`);
  lines.push("服务端已为新会话换发登录态；本浏览器是否已持有新 Cookie 以当前会话状态为准，原快捷 PIN 需要在新会话中重新设置。");
  return lines;
}

export function backupCodesReceiptLines(receipt?: BackupCodesReceipt): string[] {
  const lines: string[] = [];
  if (typeof receipt?.generation === "number") {
    lines.push(`已生成第 ${receipt.generation} 代备份码${typeof receipt.codeCount === "number" ? `（${receipt.codeCount} 枚）` : ""}；旧码全部失效。`);
  } else {
    lines.push("新一批备份码已生成；旧码全部失效。");
  }
  if (receipt?.generatedAt) lines.push(`生成时间：${formatDate(receipt.generatedAt)}。`);
  return lines;
}

export type OperationPresentation = {
  tone: "success" | "warning" | "danger" | "neutral";
  title: string;
  lines: string[];
  targetNote?: string;
};

/** 仅在 validateOperationResult 通过后调用；不再对未知状态兜底成 expired。 */
export function describeOperation(
  result: OperationReadResult,
  context: { currentSessionId?: string },
): OperationPresentation {
  const targetNote =
    result.targetKind === "session" && result.targetSessionId && result.targetSessionId !== context.currentSessionId
      ? "原作用对象是更早的会话，不能作为当前会话 PIN 状态的凭证。"
      : undefined;
  if (result.status === "completed") {
    const lines: string[] = [];
    if (result.action === "password.change") {
      const revoked = result.result?.revokedSessionCount;
      lines.push("业务变更已与回执同事务提交：密码已修改，其他设备的旧会话已撤销。");
      if (typeof revoked === "number") lines.push(`本次撤销旧会话 ${revoked} 个。`);
    } else if (result.action === "pin.set") {
      lines.push("会话 PIN 已设置（作用于回执记录的会话）。");
    } else if (result.action === "pin.change") {
      lines.push("会话 PIN 已更新（作用于回执记录的会话）。");
    } else if (result.action === "backup-codes.generate") {
      const generation = result.result?.generation;
      const codeCount = result.result?.codeCount;
      const generatedAt = result.result?.generatedAt;
      lines.push(
        `备份码已于${typeof generatedAt === "string" ? formatDate(generatedAt) : "当时"}生成${typeof generation === "number" ? `（第 ${generation} 代）` : ""}${typeof codeCount === "number" ? `，共 ${codeCount} 枚` : ""}，并已使上一批失效。`,
      );
      lines.push("明文只交付过一次，此处无法再次查看；如未收到或未保存，请明确重新生成（需要再次输入当前密码，会作废本批）。");
    } else {
      lines.push("该命令已完成。");
    }
    return { tone: "success", title: "已完成", lines, targetNote };
  }
  if (result.status === "rejected") {
    const reasonCopy = result.reason ? REASON_COPY[result.reason] : undefined;
    const lines = [reasonCopy ?? "原命令被明确拒绝。"];
    if (result.reason === "invalid_pin") lines.push("拒绝不代表未计次：请在确认会话状态后再决定是否重试，不要自动重复提交。");
    return { tone: "danger", title: "已拒绝", lines, targetNote };
  }
  if (result.status === "unconfirmed") {
    return {
      tone: "warning",
      title: "未找到记录",
      lines: [
        "没有找到该命令的回执。这不证明命令没有执行；请先核对当前会话与安全状态。",
        "如需再次操作，请由你明确重新发起一次新的操作，不要自动重发原请求。",
      ],
    };
  }
  return {
    tone: "neutral",
    title: "已超过可核对期",
    lines: [
      "该命令的身份记录仍在（同一标识重放会得到 409），但回执已超过可读期，无法展示当时结果。",
      "不能据此推断原命令未执行；请按当前安全状态判断是否需要重新操作。",
    ],
  };
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function parseResultSubset(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const subset = value as Record<string, unknown>;
  for (const key of Object.keys(subset)) {
    if (!(RESULT_SUBSET_KEYS as readonly string[]).includes(key)) return null;
  }
  if (subset.generation !== undefined && typeof subset.generation !== "number") return null;
  if (subset.codeCount !== undefined && typeof subset.codeCount !== "number") return null;
  if (subset.generatedAt !== undefined && !isIsoDate(subset.generatedAt)) return null;
  return subset;
}

/** 记录顶层白名单：未知字段一律视为损坏，绝不静默投影或落盘。 */
const PENDING_RECORD_KEYS = new Set([
  "adminUserId",
  "action",
  "commandId",
  "targetKind",
  "targetSessionId",
  "createdAt",
  "updatedAt",
  "outcome",
  "dispatched",
  "delivered",
  "dismissed",
  "result",
]);

/** 严格逐行校验；任一行损坏即整体视为读取失败，绝不静默丢弃。 */
function parsePendingRecord(value: unknown): PendingRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    if (!PENDING_RECORD_KEYS.has(key)) return null;
  }
  if (!noneEmpty(item.adminUserId) || item.adminUserId.length > 128) return null;
  const action = item.action;
  if (!isSecurityAction(action)) return null;
  if (!noneEmpty(item.commandId) || !COMMAND_ID_PATTERN.test(item.commandId)) return null;
  const targetKind: SecurityTargetKind = action.startsWith("pin.") ? "session" : "credential";
  if (item.targetKind !== targetKind) return null;
  if (targetKind === "session" && !noneEmpty(item.targetSessionId)) return null;
  if (targetKind === "credential" && item.targetSessionId !== undefined) return null;
  if (!isIsoDate(item.createdAt) || !isIsoDate(item.updatedAt)) return null;
  if (item.outcome !== "unknown" && item.outcome !== "completed" && item.outcome !== "unconfirmed" && item.outcome !== "expired") return null;
  for (const flag of ["dispatched", "delivered", "dismissed"] as const) {
    if (item[flag] !== undefined && typeof item[flag] !== "boolean") return null;
  }
  const subset = parseResultSubset(item.result);
  if (subset === null) return null;
  const record: PendingRecord = {
    adminUserId: item.adminUserId,
    action,
    commandId: item.commandId,
    targetKind,
    ...(targetKind === "session" ? { targetSessionId: item.targetSessionId as string } : {}),
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
    outcome: item.outcome,
  };
  if (typeof item.dispatched === "boolean") record.dispatched = item.dispatched;
  if (typeof item.delivered === "boolean") record.delivered = item.delivered;
  if (typeof item.dismissed === "boolean") record.dismissed = item.dismissed;
  if (subset) record.result = subset;
  return record;
}

export type PendingStoreUpdateResult = { ok: boolean; records: PendingRecord[]; reason?: "refused" | "storage" };

export type PendingStore = {
  /** 严格读取：任一记录不可辨认/键与内容不一致/存储不可用 → error=true 且不返回部分结果。 */
  read: () => { records: PendingRecord[]; error: boolean };
  /**
   * 分记录存储：读-改-写。mutate 返回 null = 调用方主动拒绝（reason "refused"）；存储失败 reason "storage"。
   * 只序列化通过严格校验的白名单投影；写入失败或回读不一致时报告失败且不覆盖旧内容。
   */
  update: (mutate: (records: readonly PendingRecord[]) => PendingRecord[] | null) => PendingStoreUpdateResult;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** 每条记录独立键：不同记录的跨标签写入互不覆盖（单次 setItem 原子），同键=同一命令意图。 */
export function pendingRecordKey(adminUserId: string, commandId: string): string {
  return `${SECURITY_PENDING_KEY}:${encodeURIComponent(adminUserId)}:${encodeURIComponent(commandId)}`;
}

const PENDING_KEY_PREFIX = `${SECURITY_PENDING_KEY}:`;

export function createLocalPendingStore(storage?: StorageLike): PendingStore {
  const resolve = (): StorageLike | undefined => {
    if (storage) return storage;
    return typeof window === "undefined" ? undefined : window.localStorage;
  };
  const readAll = (): { records: PendingRecord[]; pairs: Array<{ key: string; record: PendingRecord }>; error: boolean } => {
    try {
      const target = resolve();
      if (!target) return { records: [], pairs: [], error: true };
      const keys: string[] = [];
      for (let index = 0; index < target.length; index += 1) {
        const key = target.key(index);
        if (key && key.startsWith(PENDING_KEY_PREFIX)) keys.push(key);
      }
      keys.sort();
      const pairs: Array<{ key: string; record: PendingRecord }> = [];
      for (const key of keys) {
        const raw = target.getItem(key);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw ?? "");
        } catch {
          return { records: [], pairs: [], error: true };
        }
        const record = parsePendingRecord(parsed);
        if (!record) return { records: [], pairs: [], error: true };
        if (pendingRecordKey(record.adminUserId, record.commandId) !== key) return { records: [], pairs: [], error: true };
        pairs.push({ key, record });
      }
      const records = pairs
        .map((pair) => pair.record)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.commandId < b.commandId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
      return { records, pairs, error: false };
    } catch {
      return { records: [], pairs: [], error: true };
    }
  };
  return {
    read() {
      const current = readAll();
      return { records: current.records, error: current.error };
    },
    update(mutate) {
      const current = readAll();
      if (current.error) return { ok: false, records: [], reason: "storage" };
      const next = mutate(current.records);
      if (next === null) return { ok: false, records: current.records, reason: "refused" };
      const validated: Array<{ key: string; record: PendingRecord }> = [];
      for (const row of next) {
        const record = parsePendingRecord(row);
        if (!record) return { ok: false, records: current.records, reason: "storage" };
        validated.push({ key: pendingRecordKey(record.adminUserId, record.commandId), record });
      }
      const nextKeys = new Set(validated.map((item) => item.key));
      if (nextKeys.size !== validated.length) return { ok: false, records: current.records, reason: "storage" };
      const before = new Map(current.pairs.map((item) => [item.key, JSON.stringify(item.record)]));
      // 只写本次真正改变的记录，避免把其他标签刚更新的无关记录还原为旧快照。
      const changed = validated.filter((item) => before.get(item.key) !== JSON.stringify(item.record));
      const removedKeys = current.pairs.map((item) => item.key).filter((key) => !nextKeys.has(key));
      try {
        const target = resolve();
        if (!target) return { ok: false, records: current.records, reason: "storage" };
        for (const key of removedKeys) target.removeItem(key);
        for (const item of changed) target.setItem(item.key, JSON.stringify(item.record));
      } catch {
        return { ok: false, records: current.records, reason: "storage" };
      }
      const after = readAll();
      if (after.error) return { ok: false, records: current.records, reason: "storage" };
      const written = changed.every((item) => {
        const found = after.pairs.find((pair) => pair.key === item.key);
        return found !== undefined && JSON.stringify(found.record) === JSON.stringify(item.record);
      });
      return written ? { ok: true, records: after.records } : { ok: false, records: current.records, reason: "storage" };
    },
  };
}

export function buildPendingRecord(args: {
  adminUserId: string;
  action: SecurityAction;
  commandId: string;
  sessionId: string;
  now?: string;
}): PendingRecord {
  const targetKind: SecurityTargetKind = args.action.startsWith("pin.") ? "session" : "credential";
  const at = args.now ?? new Date().toISOString();
  return {
    adminUserId: args.adminUserId,
    action: args.action,
    commandId: args.commandId,
    targetKind,
    ...(targetKind === "session" ? { targetSessionId: args.sessionId } : {}),
    createdAt: at,
    updatedAt: at,
    outcome: "unknown",
    dispatched: false,
  };
}

export function backupCodesResultSubset(receipt?: BackupCodesReceipt): Record<string, unknown> | undefined {
  if (!receipt) return undefined;
  const subset: Record<string, unknown> = {};
  if (typeof receipt.generation === "number") subset.generation = receipt.generation;
  if (typeof receipt.generatedAt === "string") subset.generatedAt = receipt.generatedAt;
  if (typeof receipt.codeCount === "number") subset.codeCount = receipt.codeCount;
  return Object.keys(subset).length > 0 ? subset : undefined;
}

export function upsertPendingRecord(records: readonly PendingRecord[], record: PendingRecord): PendingRecord[] {
  const index = records.findIndex((item) => item.adminUserId === record.adminUserId && item.commandId === record.commandId);
  if (index === -1) return [...records, record];
  const next = records.slice();
  next[index] = record;
  return next;
}

export function removePendingRecord(records: readonly PendingRecord[], adminUserId: string, commandId: string): PendingRecord[] {
  return records.filter((item) => !(item.adminUserId === adminUserId && item.commandId === commandId));
}

export function patchPendingRecord(
  records: readonly PendingRecord[],
  adminUserId: string,
  commandId: string,
  patch: Partial<PendingRecord>,
): PendingRecord[] {
  const index = records.findIndex((item) => item.adminUserId === adminUserId && item.commandId === commandId);
  if (index === -1) return records.slice();
  const next = records.slice();
  next[index] = { ...next[index]!, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
  return next;
}

/** 未核清责任：unknown/unconfirmed/expired，或未交付的备份码 completed。 */
export function isUnresolvedRecord(record: PendingRecord): boolean {
  if (record.outcome !== "completed") return true;
  return record.action === "backup-codes.generate" && record.delivered !== true;
}

export function visiblePendingRecords(records: readonly PendingRecord[], adminUserId: string): PendingRecord[] {
  return records.filter((item) => item.adminUserId === adminUserId && item.dismissed !== true && isUnresolvedRecord(item));
}

export function dismissedPendingRecords(records: readonly PendingRecord[], adminUserId: string): PendingRecord[] {
  return records.filter((item) => item.adminUserId === adminUserId && item.dismissed === true && isUnresolvedRecord(item));
}

export type UnresolvedGate = { notice: string; fingerprint: string };

/** 未核清告知：指纹绑定具体未决集合（commandId 排序），提交前必须按最新权威集合复核。 */
export function unresolvedGate(records: readonly PendingRecord[], adminUserId: string, action: SecurityAction): UnresolvedGate | null {
  const pending = records.filter((item) => item.adminUserId === adminUserId && item.action === action && isUnresolvedRecord(item));
  if (pending.length === 0) return null;
  const ids = pending.map((item) => item.commandId).sort();
  const earliest = pending
    .slice()
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.commandId < b.commandId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))[0]!;
  return {
    notice: `该操作有 ${pending.length} 条尚未核清的本机记录（最早提交于 ${formatDate(earliest.createdAt)}）。发起新的操作不会自动核对或撤销它；请先核对原结果。`,
    fingerprint: ids.join("|"),
  };
}
