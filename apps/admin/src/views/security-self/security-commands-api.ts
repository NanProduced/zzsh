/**
 * ADM-SECURITY-BACKEND-1 · 本人安全命令薄适配（R1）。
 *
 * 只做路径/头/正文映射：复用 `adminRequest`（Cookie、401/423 协调、AdminApiError 都在它里面），
 * commandId 只进 Idempotency-Key（覆盖默认随机 key），不混入业务正文；
 * 不在此处判定业务成功（model.ts 的 verifyCommandSuccess / asCommandError 负责）。
 */
import { adminRequest } from "../../api";
import type {
  BackupCodesEnvelope,
  OperationReadResult,
  PasswordChangeEnvelope,
  PinEnvelope,
  SecurityCommands,
} from "./model.ts";

export const securityCommands: SecurityCommands = {
  // 与旧正式页相同 URL 与 revokeOtherSessions 语义；服务端在同一事务里更新凭据、
  // 撤销全部旧会话并签发新会话，回执核对由原结果查询完成。
  changePassword: ({ commandId, currentPassword, newPassword }) =>
    adminRequest<PasswordChangeEnvelope>("/auth/change-password", { currentPassword, newPassword, revokeOtherSessions: true }, "POST", { "idempotency-key": commandId }),
  setPin: ({ commandId, pin }) =>
    adminRequest<PinEnvelope>("/security/pin/set", { pin }, "POST", { "idempotency-key": commandId }),
  changePin: ({ commandId, currentPin, newPin }) =>
    adminRequest<PinEnvelope>("/security/pin/change", { currentPin, newPin }, "POST", { "idempotency-key": commandId }),
  generateBackupCodes: ({ commandId, password }) =>
    adminRequest<BackupCodesEnvelope>("/auth/two-factor/generate-backup-codes", { password }, "POST", { "idempotency-key": commandId }),
  readOperation: ({ commandId }) =>
    adminRequest<OperationReadResult>("/security/operation", { commandId }, "POST"),
};
